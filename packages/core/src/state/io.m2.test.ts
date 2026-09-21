import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyState } from "./schema.js";
import { readRawState, writeStateAtomic } from "./io.js";
import { StateCorruptError } from "./errors.js";

// Core has zero @wappy/* dependencies by design (hub-and-spoke) — testkit itself depends on
// core, so these tests use a plain mkdtemp helper rather than testkit's tmpProject().
const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-core-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readRawState", () => {
  test("returns null when no file exists", () => {
    expect(readRawState(join(tmpDir(), ".wappy/state.json"))).toBeNull();
  });

  test("throws StateCorruptError on invalid JSON", () => {
    const f = join(tmpDir(), "state.json");
    writeFileSync(f, "{ not json");
    expect(() => readRawState(f)).toThrow(StateCorruptError);
  });

  test("throws StateCorruptError on a truncated file", () => {
    const f = join(tmpDir(), "state.json");
    writeFileSync(f, '{"schemaVersion": 1, "runId": "r1", "step');
    expect(() => readRawState(f)).toThrow(StateCorruptError);
  });
});

describe("writeStateAtomic + readRawState round-trip", () => {
  test("writes and reads back the same state", () => {
    const f = join(tmpDir(), "state.json");
    const state = createEmptyState("run1", { now: () => 100 });
    writeStateAtomic(f, state);
    expect(readRawState(f)).toEqual(state);
  });

  test("creates the parent directory if missing", () => {
    const f = join(tmpDir(), "nested/dir/.wappy/state.json");
    writeStateAtomic(f, createEmptyState("run1"));
    expect(existsSync(f)).toBe(true);
  });

  test("no leftover temp file after a successful write", () => {
    const dir = tmpDir();
    writeStateAtomic(join(dir, "state.json"), createEmptyState("run1"));
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("strips a smuggled-in env key value before it ever reaches disk", () => {
    const f = join(tmpDir(), "state.json");
    const state = createEmptyState("run1");
    const canary = "canary-do-not-persist-12345";
    // @ts-expect-error deliberately attaching a non-schema field to prove it never gets written
    state.envKeys.push({ name: "SECRET", required: true, filled: true, value: canary });
    writeStateAtomic(f, state);
    expect(JSON.stringify(readRawState(f))).not.toContain(canary);
  });

  test("a half-written temp file left behind by a simulated crash never corrupts the committed state", () => {
    const dir = tmpDir();
    const f = join(dir, "state.json");
    const stateA = createEmptyState("run-A", { now: () => 1 });
    writeStateAtomic(f, stateA);

    // Simulate: a previous process died between writing its temp file and renaming it into place.
    writeFileSync(join(dir, ".state.json.99999.leftover.tmp"), "{not valid json, mid-write");

    // rename(2) is atomic — readers of the real path are unaffected by the orphaned temp file.
    expect(readRawState(f)).toEqual(stateA);

    // A later successful write still works fine.
    const stateB = createEmptyState("run-B", { now: () => 2 });
    writeStateAtomic(f, stateB);
    expect(readRawState(f)).toEqual(stateB);
  });
});
