import { describe, expect, test } from "vitest";
import { createEmptyState } from "./schema.js";
import { applyManifests } from "./manifest.js";
import type { SetupManifest } from "../setup-manifest.js";

const parts = [
  { name: "whatsapp", version: "0.1.0" },
  { name: "harness", version: "0.1.0" },
];
const manifests: SetupManifest[] = [
  { part: "whatsapp", steps: [{ id: "creds", description: "WA creds", envKeys: ["WA_TOKEN"] }] },
  { part: "harness", steps: [{ id: "model-key", description: "Model key", envKeys: ["OPENAI_API_KEY"] }] },
];

describe("applyManifests", () => {
  test("a fresh state gets pending steps and unfilled env keys for every declared step", () => {
    const { state, removedStepIds } = applyManifests(createEmptyState("r1"), parts, manifests, { now: () => 1 });
    expect(state.parts).toEqual(parts);
    expect(state.steps).toEqual([
      { id: "creds", part: "whatsapp", status: "pending" },
      { id: "model-key", part: "harness", status: "pending" },
    ]);
    expect(state.envKeys).toEqual([
      { name: "WA_TOKEN", required: true, filled: false },
      { name: "OPENAI_API_KEY", required: true, filled: false },
    ]);
    expect(removedStepIds).toEqual([]);
  });

  test("preserves an existing step's status and an env key's filled flag", () => {
    const seeded = {
      ...createEmptyState("r1"),
      steps: [{ id: "creds", part: "whatsapp", status: "done" as const }],
      envKeys: [{ name: "WA_TOKEN", required: true, filled: true }],
    };
    const { state } = applyManifests(seeded, parts, manifests);
    expect(state.steps.find((s) => s.id === "creds")).toEqual({ id: "creds", part: "whatsapp", status: "done" });
    expect(state.envKeys.find((e) => e.name === "WA_TOKEN")).toEqual({ name: "WA_TOKEN", required: true, filled: true });
  });

  test("a step no longer contributed by any part is pulled out of steps and reported as removed", () => {
    const seeded = {
      ...createEmptyState("r1"),
      steps: [
        { id: "creds", part: "whatsapp", status: "done" as const },
        { id: "old-step", part: "some-removed-plugin", status: "done" as const },
      ],
    };
    const { state, removedStepIds } = applyManifests(seeded, parts, manifests);
    expect(state.steps.map((s) => s.id)).toEqual(["creds", "model-key"]);
    expect(removedStepIds).toEqual(["old-step"]);
  });

  test("no manifests -> empty steps/envKeys, existing state.parts replaced", () => {
    const seeded = { ...createEmptyState("r1"), parts: [{ name: "stale", version: "0.0.1" }] };
    const { state } = applyManifests(seeded, [], []);
    expect(state.parts).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.envKeys).toEqual([]);
  });
});
