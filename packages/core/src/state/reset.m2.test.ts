import { describe, expect, test } from "vitest";
import { createEmptyState } from "./schema.js";
import { reset } from "./reset.js";

function seeded() {
  return {
    ...createEmptyState("run1", { now: () => 1 }),
    parts: [
      { name: "whatsapp", version: "0.1.0" },
      { name: "harness", version: "0.1.0" },
    ],
    steps: [
      { id: "creds", part: "whatsapp", status: "done" as const },
      { id: "model-key", part: "harness", status: "done" as const },
    ],
    envKeys: [{ name: "WA_TOKEN", required: true, filled: true }],
    generatedFiles: [
      { path: "whatsapp/webhook.ts", part: "whatsapp", sha256: "a" },
      { path: "index.ts", part: "harness", sha256: "b" },
    ],
  };
}

describe("reset", () => {
  test("scope 'all' returns an empty state (same runId) and every generated file to remove", () => {
    const { state, filesToRemove } = reset(seeded(), { kind: "all" }, { now: () => 99 });
    expect(state).toEqual(createEmptyState("run1", { now: () => 99 }));
    expect(filesToRemove.sort()).toEqual(["index.ts", "whatsapp/webhook.ts"]);
  });

  test("scope 'plugin' removes only that part's parts/steps/generatedFiles entries", () => {
    const { state, filesToRemove } = reset(seeded(), { kind: "plugin", name: "whatsapp" }, { now: () => 99 });
    expect(state.parts).toEqual([{ name: "harness", version: "0.1.0" }]);
    expect(state.steps).toEqual([{ id: "model-key", part: "harness", status: "done" }]);
    expect(state.generatedFiles).toEqual([{ path: "index.ts", part: "harness", sha256: "b" }]);
    expect(filesToRemove).toEqual(["whatsapp/webhook.ts"]);
    expect(state.updatedAt).toBe(99);
  });

  test("scope 'plugin' leaves envKeys untouched (v1: not part-scoped)", () => {
    const { state } = reset(seeded(), { kind: "plugin", name: "whatsapp" });
    expect(state.envKeys).toEqual([{ name: "WA_TOKEN", required: true, filled: true }]);
  });

  test("resetting an unknown plugin name is a no-op (nothing matches)", () => {
    const before = seeded();
    const { state, filesToRemove } = reset(before, { kind: "plugin", name: "nope" }, { now: () => 99 });
    expect(state.parts).toEqual(before.parts);
    expect(state.steps).toEqual(before.steps);
    expect(filesToRemove).toEqual([]);
  });
});
