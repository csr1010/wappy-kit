import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";

export interface TmpProject {
  dir: string;
  home: string;
  path(rel: string): string;
  write(rel: string, content: string): string;
  cleanup(): void;
}

const live = new Set<TmpProject>();

/** Temp dir + isolated HOME (process.env.HOME is swapped until cleanup). */
export function tmpProject(): TmpProject {
  const root = mkdtempSync(join(tmpdir(), "wappy-tk-"));
  const dir = join(root, "project");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const p: TmpProject = {
    dir,
    home,
    path: (rel) => join(dir, rel),
    write(rel, content) {
      const f = join(dir, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
      return f;
    },
    cleanup() {
      if (!live.delete(p)) return;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
  live.add(p);
  return p;
}

/** Call from afterEach so leaked projects never survive a test. */
export function cleanupAllTmpProjects(): void {
  // Reverse order so nested HOME swaps unwind back to the original value.
  for (const p of [...live].reverse()) p.cleanup();
}
process.on("exit", cleanupAllTmpProjects);

export interface FakeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
}

/** Deterministic clock: nothing fires until advance() is called. */
export function fakeClock(start = 0): FakeClock {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const c: FakeClock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h),
    sleep: (ms) => new Promise((r) => c.setTimeout(r, ms)),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        // Earliest due timer first; ties break by creation order (Map iteration order).
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = target;
    },
  };
  return c;
}

/** Valid X-Hub-Signature-256 header value for a raw body. */
export function signWebhook(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
