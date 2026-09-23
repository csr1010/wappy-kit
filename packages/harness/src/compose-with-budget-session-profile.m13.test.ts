import { describe, expect, test } from "vitest";
import type { Model } from "@wappy/core";
import { composeWithBudget } from "./compose-with-budget.js";
import { createContextBudget } from "./context-budget.js";

const budget = createContextBudget("gpt-4o-mini", { overrides: { contextWindow: 10_000, reservedOutputTokens: 0 } });

/**
 * M13: the compose call's wrapped response schema (already carrying `formatRationale` since M12)
 * also carries the session-profile extraction fields — zero extra model calls, same response.
 */
describe("composeWithBudget — session-profile extraction (M13)", () => {
  test("sessionFacts/sessionCurrentState/sessionSummary survive a round trip when the model returns them", async () => {
    const model: Model = {
      generate: async () => ({
        structured: {
          formatRationale: "test rationale",
          sessionFacts: { name: "Jane" },
          sessionCurrentState: "picking a candle size",
          sessionSummary: "Jane is browsing the candle collection",
          message: { text: "sure, what size?" },
        },
      }),
    };
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hi" }, budget });
    expect(result.sessionFacts).toEqual({ name: "Jane" });
    expect(result.sessionCurrentState).toBe("picking a candle size");
    expect(result.sessionSummary).toBe("Jane is browsing the candle collection");
  });

  test("all three are optional — absent when the model doesn't return them, no error", async () => {
    const model: Model = { generate: async () => ({ structured: { formatRationale: "test rationale", message: { text: "hi!" } } }) };
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hi" }, budget });
    expect(result.sessionFacts).toBeUndefined();
    expect(result.sessionCurrentState).toBeUndefined();
    expect(result.sessionSummary).toBeUndefined();
    expect(result.reply).toEqual({ text: "hi!" });
  });

  test("absent on the honest-degrade fallback path — never a fabricated extraction", async () => {
    const model: Model = { generate: async () => ({ structured: { garbage: true } }) };
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hi" }, budget });
    expect(result.sessionFacts).toBeUndefined();
    expect(result.sessionCurrentState).toBeUndefined();
    expect(result.sessionSummary).toBeUndefined();
  });

  test("a partial extraction (only sessionCurrentState) is accepted, the other two stay absent", async () => {
    const model: Model = {
      generate: async () => ({ structured: { formatRationale: "test rationale", sessionCurrentState: "waiting on payment", message: { text: "ok" } } }),
    };
    const result = await composeWithBudget({ model, input: { system: "SYS", userMessage: "hi" }, budget });
    expect(result.sessionCurrentState).toBe("waiting on payment");
    expect(result.sessionFacts).toBeUndefined();
    expect(result.sessionSummary).toBeUndefined();
  });
});
