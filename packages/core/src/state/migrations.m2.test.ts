import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { migrate } from "./migrations.js";
import { StateCorruptError, StateVersionTooNewError } from "./errors.js";
import { STATE_SCHEMA_VERSION } from "./schema.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const stateFixturesDir = resolve(repoRoot, "fixtures/state");

describe("migrate", () => {
  test("throws StateCorruptError when schemaVersion is missing", () => {
    expect(() => migrate({ runId: "r1" })).toThrow(StateCorruptError);
  });

  test.each([["not-a-number"], [1.5], [0], [-1], [null]])("throws StateCorruptError for an invalid schemaVersion %s", (v) => {
    expect(() => migrate({ schemaVersion: v, runId: "r1" })).toThrow(StateCorruptError);
  });

  test("refuses (does not silently downgrade) a schemaVersion newer than this build supports", () => {
    // A synthetic future version — not a committed fixture, since fixtures/ is for real historical
    // schemas we must keep loading forever, and there is no real "schema v999" yet.
    expect(() => migrate({ schemaVersion: STATE_SCHEMA_VERSION + 1, runId: "r1" })).toThrow(StateVersionTooNewError);
    try {
      migrate({ schemaVersion: 999, runId: "r1" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(StateVersionTooNewError);
      expect((e as StateVersionTooNewError).foundVersion).toBe(999);
      expect((e as StateVersionTooNewError).supportedVersion).toBe(STATE_SCHEMA_VERSION);
      expect((e as Error).message).toMatch(/upgrade/i);
    }
  });

  test("throws StateCorruptError when there's no migration path from an old-but-known version", () => {
    // Only relevant once STATE_SCHEMA_VERSION > 1 and a step is deliberately skipped; guards the chain logic itself.
    expect(() => migrate({ schemaVersion: 1, runId: "r1", parts: [], steps: [], envKeys: [], lastStep: null, generatedFiles: [], createdAt: 0, updatedAt: "not-a-number" })).toThrow(
      StateCorruptError,
    );
  });

  test("loads every committed fixtures/state/v*.json (B4: must load forever)", () => {
    const files = readdirSync(stateFixturesDir).filter((f) => /^v\d+\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(resolve(stateFixturesDir, f), "utf8"));
      const state = migrate(raw);
      expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      expect(state.runId).toBe(raw.runId);
    }
  });
});
