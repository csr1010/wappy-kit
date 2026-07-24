import { describe, expect, test } from "vitest";
import { aggregateSetupManifests, type SetupManifest } from "./setup-manifest.js";

describe("aggregateSetupManifests", () => {
  test("flattens steps and attributes each to its part", () => {
    const manifests: SetupManifest[] = [
      { part: "whatsapp", steps: [{ id: "creds", description: "WhatsApp creds", envKeys: ["WA_TOKEN"] }] },
      { part: "harness", steps: [{ id: "model-key", description: "Model API key", envKeys: ["OPENAI_API_KEY"] }] },
    ];
    const { steps } = aggregateSetupManifests(manifests);
    expect(steps).toEqual([
      { id: "creds", description: "WhatsApp creds", envKeys: ["WA_TOKEN"], part: "whatsapp" },
      { id: "model-key", description: "Model API key", envKeys: ["OPENAI_API_KEY"], part: "harness" },
    ]);
  });

  test("dedupes env keys across parts", () => {
    const manifests: SetupManifest[] = [
      { part: "harness", steps: [{ id: "a", description: "a", envKeys: ["SHARED_KEY", "A_KEY"] }] },
      { part: "tools", steps: [{ id: "b", description: "b", envKeys: ["SHARED_KEY", "B_KEY"] }] },
    ];
    const { envKeys } = aggregateSetupManifests(manifests);
    expect(new Set(envKeys)).toEqual(new Set(["SHARED_KEY", "A_KEY", "B_KEY"]));
  });

  test("throws on a duplicate step id within the same part", () => {
    const manifests: SetupManifest[] = [
      { part: "whatsapp", steps: [{ id: "creds", description: "first" }, { id: "creds", description: "second" }] },
    ];
    expect(() => aggregateSetupManifests(manifests)).toThrow(/duplicate step/i);
  });

  test("same step id across different parts is fine", () => {
    const manifests: SetupManifest[] = [
      { part: "whatsapp", steps: [{ id: "creds", description: "wa creds" }] },
      { part: "shopify", steps: [{ id: "creds", description: "shopify creds" }] },
    ];
    expect(() => aggregateSetupManifests(manifests)).not.toThrow();
  });

  test("no steps with envKeys -> empty envKeys list", () => {
    const { envKeys } = aggregateSetupManifests([{ part: "x", steps: [{ id: "s", description: "d" }] }]);
    expect(envKeys).toEqual([]);
  });
});
