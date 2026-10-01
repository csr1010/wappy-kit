import { describe, expect, test } from "vitest";
import {
  applyAnswer,
  assertComplete,
  DEFAULT_ANSWERS,
  goBack,
  INTERVIEW_STEP_ORDER,
  isComplete,
  nextQuestion,
  nextStep,
  questionFor,
  skipStep,
  type InterviewAnswers,
} from "./interview.js";

function must(r: ReturnType<typeof applyAnswer>): InterviewAnswers {
  if (!r.ok) throw new Error(`test setup: ${r.errors.join(", ")}`);
  return r.answers;
}

const openai = { provider: "openai" } as const;
const localMemory = { backend: "local" } as const;
const noProductivity = { enabled: false } as const;

// The interview's "tools" step (M9, Shopify) was removed entirely: domain connectors are out of
// scope for this open-source repo now (see docs/SPEC.md's decisions log) — they live in a separate
// connectors repo, wired into an agent by hand, not through this CLI.
//
// A "productivity" step was added back later (@wappy_ai/productivity — not domain-specific, so this
// doesn't reopen the boundary above): the interview is now model + productivity, not model-only.
//
// --allow-test-change (M15, "Memory backend — local vs. Cognee"): a "memory" step was inserted
// between "model" and "productivity" — retrieved-knowledge/RAG backend choice (local vs. Cognee).
// Every assertion below that hardcoded the old 2-step order/shape needed updating.
describe("the interview asks only what changes the generated code, and never a credential", () => {
  test("step order is model, memory, productivity", () => {
    expect([...INTERVIEW_STEP_ORDER]).toEqual(["model", "memory", "productivity"]);
  });

  test("questions carry prompts + choices; no free-text or credential questions exist", () => {
    for (const step of INTERVIEW_STEP_ORDER) {
      const q = questionFor(step);
      expect(q.step).toBe(step);
      expect(q.choices?.length).toBeGreaterThan(0);
    }
    expect(questionFor("model").choices?.map((c) => c.value)).toEqual(["openai", "anthropic", "gemini", "ollama"]);
    expect(questionFor("memory").choices?.map((c) => c.value)).toEqual(["local", "cognee"]);
    expect(questionFor("productivity").choices?.map((c) => c.value)).toEqual(["no", "yes"]);
  });

  test("the memory step's cognee choice carries a real explanatory hint, not just a bare label", () => {
    const cognee = questionFor("memory").choices?.find((c) => c.value === "cognee");
    expect(cognee?.hint).toBeTruthy();
    expect(cognee?.hint).toMatch(/knowledge graph/i);
  });
});

describe("the interview is complete once every step is answered", () => {
  test("answering model, memory, then productivity completes the interview", () => {
    let a: InterviewAnswers = {};
    expect(nextStep(a)).toBe("model");
    a = must(applyAnswer(a, "model", openai));
    expect(nextStep(a)).toBe("memory");
    a = must(applyAnswer(a, "memory", localMemory));
    expect(nextStep(a)).toBe("productivity");
    a = must(applyAnswer(a, "productivity", noProductivity));
    expect(nextStep(a)).toBeNull();
    expect(nextQuestion(a)).toBeNull();
    expect(isComplete(a)).toBe(true);
  });
});

describe("assertComplete", () => {
  test("assertComplete throws naming the first unanswered step", () => {
    expect(() => assertComplete({})).toThrow(/"model" hasn't been answered/);
  });

  test("assertComplete throws naming memory once model is answered but memory isn't", () => {
    expect(() => assertComplete({ model: openai })).toThrow(/"memory" hasn't been answered/);
  });

  test("assertComplete throws naming productivity once model+memory are answered but productivity isn't", () => {
    expect(() => assertComplete({ model: openai, memory: localMemory })).toThrow(/"productivity" hasn't been answered/);
  });

  test("assertComplete passes once every step is answered", () => {
    expect(() => assertComplete({ model: openai, memory: localMemory, productivity: noProductivity })).not.toThrow();
  });
});

describe("applyAnswer validation", () => {
  test("an already-answered step can be revised in place", () => {
    const a = must(applyAnswer({}, "model", openai));
    const revised = must(applyAnswer(a, "model", { provider: "anthropic" }));
    expect(revised.model).toEqual({ provider: "anthropic" });
  });

  test("a missing model provider is rejected", () => {
    const r = applyAnswer({}, "model", {} as never);
    expect(r.ok).toBe(false);
  });

  test("a missing/invalid memory backend is rejected", () => {
    expect(applyAnswer({}, "memory", {} as never).ok).toBe(false);
    expect(applyAnswer({}, "memory", { backend: "redis" } as never).ok).toBe(false);
  });

  test("a valid memory backend (local or cognee) is accepted", () => {
    expect(applyAnswer({}, "memory", { backend: "local" }).ok).toBe(true);
    expect(applyAnswer({}, "memory", { backend: "cognee" }).ok).toBe(true);
  });

  test("a missing productivity enabled flag is rejected", () => {
    const r = applyAnswer({}, "productivity", {} as never);
    expect(r.ok).toBe(false);
  });
});

describe("goBack / skipStep / defaults", () => {
  test("goBack clears the target step, back to unanswered", () => {
    const a = must(applyAnswer({}, "model", openai));
    const back = goBack(a, "model");
    expect(back).toEqual({});
    expect(nextStep(back)).toBe("model");
  });

  test("goBack to memory clears memory and everything after it (productivity), but not model", () => {
    let a: InterviewAnswers = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "memory", localMemory));
    a = must(applyAnswer(a, "productivity", noProductivity));
    const back = goBack(a, "memory");
    expect(back).toEqual({ model: openai });
    expect(nextStep(back)).toBe("memory");
  });

  test("defaults: openai, local memory, productivity off", () => {
    expect(DEFAULT_ANSWERS).toEqual({ model: openai, memory: localMemory, productivity: noProductivity });
  });

  test("skipping every step completes the interview with the defaults", () => {
    let a: InterviewAnswers = {};
    while (!isComplete(a)) a = must(skipStep(a, nextStep(a)!));
    expect(a).toEqual({ model: openai, memory: localMemory, productivity: noProductivity });
  });
});
