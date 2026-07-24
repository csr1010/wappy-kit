import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLockStale, releaseLock, tryAcquireLock, withLock } from "./lock.js";
import { LockTimeoutError } from "./errors.js";

const dirs: string[] = [];
function lockPath(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-core-lock-"));
  dirs.push(d);
  return join(d, "lock");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("tryAcquireLock / releaseLock", () => {
  test("acquires when no lock file exists", () => {
    const p = lockPath();
    expect(tryAcquireLock(p)).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  test("fails to acquire when already held", () => {
    const p = lockPath();
    expect(tryAcquireLock(p)).toBe(true);
    expect(tryAcquireLock(p)).toBe(false);
  });

  test("releaseLock removes the file; re-acquiring then works", () => {
    const p = lockPath();
    tryAcquireLock(p);
    releaseLock(p);
    expect(existsSync(p)).toBe(false);
    expect(tryAcquireLock(p)).toBe(true);
  });

  test("releaseLock on a missing lock is a no-op", () => {
    expect(() => releaseLock(lockPath())).not.toThrow();
  });

  test("a non-EEXIST failure (e.g. missing parent directory) is not swallowed", () => {
    expect(() => tryAcquireLock(join(lockPath(), "nested", "lock"))).toThrow(/ENOENT/);
  });

  test("a non-ENOENT release failure is not swallowed", () => {
    const p = lockPath();
    mkdirSync(p); // a directory, not a lock file — unlink fails with something other than ENOENT
    expect(() => releaseLock(p)).toThrow();
  });
});

describe("isLockStale", () => {
  test("a missing lock file is stale (nothing to take over from)", () => {
    expect(isLockStale(lockPath(), 30_000)).toBe(true);
  });

  test("a corrupt lock file is stale", () => {
    const p = lockPath();
    writeFileSync(p, "not json");
    expect(isLockStale(p, 30_000)).toBe(true);
  });

  test("a fresh lock (age < staleMs) held by a live pid is not stale", () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    expect(isLockStale(p, 30_000)).toBe(false);
  });

  test("an old lock held by a live pid is still not stale (owner might just be slow)", () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60_000 }));
    expect(isLockStale(p, 30_000)).toBe(false);
  });

  test("an old lock whose pid is dead is stale", () => {
    const p = lockPath();
    // A pid this large is essentially guaranteed not to exist.
    writeFileSync(p, JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() - 60_000 }));
    expect(isLockStale(p, 30_000)).toBe(true);
  });
});

describe("withLock", () => {
  test("acquires, runs fn, releases", async () => {
    const p = lockPath();
    const result = await withLock(p, () => {
      expect(existsSync(p)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(p)).toBe(false);
  });

  test("releases even when fn throws", async () => {
    const p = lockPath();
    await expect(
      withLock(p, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(p)).toBe(false);
  });

  test("two sequential withLock calls on the same path both succeed", async () => {
    const p = lockPath();
    await withLock(p, () => {});
    await withLock(p, () => {});
    expect(existsSync(p)).toBe(false);
  });

  test("times out (LockTimeoutError) when a live, fresh lock never frees up", async () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    await expect(withLock(p, () => {}, { timeoutMs: 40, pollMs: 5, staleMs: 10_000 })).rejects.toThrow(LockTimeoutError);
  });

  test("recovers from a stale lock (dead pid) and runs fn without waiting for a timeout", async () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() - 1000 }));
    const result = await withLock(p, () => "ran", { staleMs: 10, timeoutMs: 500, pollMs: 5 });
    expect(result).toBe("ran");
    expect(existsSync(p)).toBe(false);
  });
});
