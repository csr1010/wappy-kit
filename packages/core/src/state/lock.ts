import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { systemClock, type Clock } from "../clock.js";
import { LockTimeoutError } from "./errors.js";

export interface LockOptions {
  /** A lock older than this whose owning pid is dead is stale and can be taken over. Default 30s. */
  staleMs?: number;
  /** How long to wait for a live lock to free up before giving up. Default 5s. */
  timeoutMs?: number;
  pollMs?: number;
}

interface LockContents {
  pid: number;
  acquiredAt: number;
}

/** true = acquired. false = someone else holds it (EEXIST). */
export function tryAcquireLock(path: string, clock: Pick<Clock, "now"> = systemClock): boolean {
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: clock.now() } satisfies LockContents));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function readLockContents(path: string): LockContents | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // missing, or corrupt — both treated as stale by the caller
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead). EPERM = exists but owned by someone else (alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock is stale once it's older than staleMs AND its owning pid is no longer alive. This is
 * also the crash-recovery path: nothing runs on SIGKILL, so a `finally`/exit-hook can never
 * release the lock file for us — staleness detection on the NEXT acquire attempt is the only
 * reliable way a killed holder's lock gets reclaimed.
 */
export function isLockStale(path: string, staleMs: number, clock: Pick<Clock, "now"> = systemClock): boolean {
  const contents = readLockContents(path);
  if (!contents) return true;
  if (clock.now() - contents.acquiredAt < staleMs) return false;
  return !isProcessAlive(contents.pid);
}

export async function withLock<T>(path: string, fn: () => Promise<T> | T, opts: LockOptions = {}, clock: Clock = systemClock): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 20;
  const deadline = clock.now() + timeoutMs;

  for (;;) {
    if (tryAcquireLock(path, clock)) break;
    if (isLockStale(path, staleMs, clock)) {
      releaseLock(path);
      continue;
    }
    if (clock.now() >= deadline) throw new LockTimeoutError(`timed out waiting for lock at ${path}`);
    await clock.sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    releaseLock(path);
  }
}
