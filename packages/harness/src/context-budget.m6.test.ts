import { describe, expect, test } from "vitest";
import { charsPerTokenEstimator, createContextBudget } from "./context-budget.js";

describe("charsPerTokenEstimator", () => {
  test("estimates roughly chars/3.5, rounded up", () => {
    expect(charsPerTokenEstimator.estimate("a".repeat(35))).toBe(10);
    expect(charsPerTokenEstimator.estimate("a".repeat(36))).toBe(11); // rounds up, never under-counts
  });

  test("empty string estimates zero tokens", () => {
    expect(charsPerTokenEstimator.estimate("")).toBe(0);
  });
});

describe("createContextBudget — known models", () => {
  test("a known model gets its real context window minus reserved output tokens", () => {
    const budget = createContextBudget("gpt-4o");
    expect(budget.promptBudget).toBeGreaterThan(0);
    expect(budget.promptBudget).toBeLessThan(128_000); // less than the full window — some is reserved for output
  });

  test("two different known models have different budgets (not all collapsed to one default)", () => {
    const a = createContextBudget("gpt-4o-mini");
    const b = createContextBudget("claude-3-5-sonnet");
    expect(a.promptBudget).not.toBe(b.promptBudget);
  });
});

describe("createContextBudget — unknown model", () => {
  test("an unrecognized model id falls back to a conservative default, not a crash or an unbounded window", () => {
    const budget = createContextBudget("some-brand-new-model-nobody-has-heard-of");
    expect(budget.promptBudget).toBeGreaterThan(0);
    expect(budget.promptBudget).toBeLessThan(20_000); // conservative — well under any real frontier model's window
  });
});

describe("createContextBudget — overrides and estimator", () => {
  test("explicit overrides win over the known/default table", () => {
    const budget = createContextBudget("gpt-4o", { overrides: { contextWindow: 1000, reservedOutputTokens: 100 } });
    expect(budget.promptBudget).toBe(900);
  });

  test("a custom TokenEstimator is used instead of the default chars/3.5 fallback", () => {
    const budget = createContextBudget("gpt-4o", { estimator: { estimate: () => 42 } });
    expect(budget.estimator.estimate("anything")).toBe(42);
  });

  test("defaults to charsPerTokenEstimator when no estimator is given", () => {
    const budget = createContextBudget("gpt-4o");
    expect(budget.estimator.estimate("a".repeat(35))).toBe(10);
  });
});
