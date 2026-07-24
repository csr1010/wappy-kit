import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState } from "./load.js";
import { writeStateAtomic } from "./io.js";
import { createEmptyState, STATE_SCHEMA_VERSION } from "./schema.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-core-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadState", () => {
  test("no file yet -> ok with state: null (fresh project)", () => {
    const f = join(tmpDir(), "state.json");
    expect(loadState(f)).toEqual({ ok: true, state: null });
  });

  test("a valid state file -> ok with the loaded state", () => {
    const f = join(tmpDir(), "state.json");
    const state = createEmptyState("run1", { now: () => 5 });
    writeStateAtomic(f, state);
    expect(loadState(f)).toEqual({ ok: true, state });
  });

  test("corrupt JSON -> not ok, corrupt offer (no throw)", () => {
    const f = join(tmpDir(), "state.json");
    writeFileSync(f, "{ broken");
    const result = loadState(f);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ corrupt: true, path: f });
  });

  test("schemaVersion newer than supported -> not ok, tooNew offer (no throw)", () => {
    const f = join(tmpDir(), "state.json");
    writeFileSync(f, JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, runId: "r1" }));
    const result = loadState(f);
    expect(result).toEqual({ ok: false, tooNew: true, path: f, foundVersion: STATE_SCHEMA_VERSION + 1, supportedVersion: STATE_SCHEMA_VERSION });
  });
});
