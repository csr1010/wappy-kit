import { describe, expect, test } from "vitest";
import { createEmptyState, STATE_SCHEMA_VERSION, StateSchema } from "./schema.js";

describe("createEmptyState", () => {
  test("has schemaVersion 1 and empty collections", () => {
    const s = createEmptyState("run1", { now: () => 42 });
    expect(s).toEqual({
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: "run1",
      parts: [],
      steps: [],
      envKeys: [],
      lastStep: null,
      generatedFiles: [],
      createdAt: 42,
      updatedAt: 42,
    });
  });

  test("round-trips through StateSchema", () => {
    expect(StateSchema.safeParse(createEmptyState("run1")).success).toBe(true);
  });
});

describe("StateSchema", () => {
  const valid = createEmptyState("run1", { now: () => 1 });

  test("rejects a schemaVersion other than the current one", () => {
    expect(StateSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });

  test("rejects an env key with an unknown extra field but keeps validating the rest", () => {
    // required/filled must still be booleans even if a caller tries to smuggle other data in.
    const bad = { ...valid, envKeys: [{ name: "X", required: "yes", filled: false }] };
    expect(StateSchema.safeParse(bad).success).toBe(false);
  });

  test("strips (does not error on) an unexpected extra field on an env key", () => {
    // Deliberately smuggling an extra field to prove it gets dropped, not stored.
    const withCanary = { ...valid, envKeys: [{ name: "SECRET", required: true, filled: true, value: "canary-do-not-persist" }] };
    const parsed = StateSchema.safeParse(withCanary);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.success ? parsed.data : null)).not.toContain("canary-do-not-persist");
  });
});
