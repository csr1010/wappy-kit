import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "./lock.js";

const here = dirname(fileURLToPath(import.meta.url));
const raceWorker = join(here, "test-workers/lock-race.worker.mjs");
const crashWorker = join(here, "test-workers/lock-crash.worker.mjs");

function runAsync(script: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// These spawn real OS processes; give them real (not fake-clock) time budget.
describe("cross-process lock races", () => {
  test("5 real processes race withLock's O_EXCL primitive concurrently; exactly one is ever inside at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wappy-core-lock-race-"));
    const lockPath = join(dir, "lock");
    const counterPath = join(dir, "counter");
    writeFileSync(counterPath, "0");

    // spawn (not spawnSync) + Promise.all so all 5 children actually run concurrently, not one at a time.
    const children = await Promise.all(Array.from({ length: 5 }, () => runAsync(raceWorker, [lockPath, counterPath, "3"])));

    rmSync(dir, { recursive: true, force: true });

    const failures = children.filter((c) => c.code !== 0);
    if (failures.length) {
      throw new Error(`${failures.length}/5 workers detected an overlap (mutual exclusion violated):\n${failures.map((c) => c.stderr).join("\n")}`);
    }
    expect(children).toHaveLength(5);
  }, 20_000);

  test("a lock left behind by a killed (SIGKILL) holder is recovered as stale, not waited out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wappy-core-lock-crash-"));
    const lockPath = join(dir, "lock");

    const killed = spawnSync(process.execPath, [crashWorker, lockPath], { encoding: "utf8" });
    expect(killed.signal).toBe("SIGKILL");
    expect(existsSync(lockPath)).toBe(true); // left behind, exactly like a real crash

    const t0 = Date.now();
    const result = await withLock(lockPath, () => "recovered", { staleMs: 20, timeoutMs: 2000, pollMs: 5 });
    const elapsed = Date.now() - t0;

    expect(result).toBe("recovered");
    expect(elapsed).toBeLessThan(2000); // recovered via staleness, not by exhausting the timeout
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
