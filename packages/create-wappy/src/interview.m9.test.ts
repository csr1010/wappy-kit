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
const noProductivity = { enabled: false } as const;

// The interview's "tools" step (M9, Shopify) was removed entirely: domain connectors are out of
// scope for this open-source repo now (see docs/SPEC.md's decisions log) — they live in a separate
// connectors repo, wired into an agent by hand, not through this CLI.
//
// A "productivity" step was added back later (@wappy_ai/productivity — not domain-specific, so this
// doesn't reopen the boundary above): the interview is now model + productivity, not model-only.
// Every assertion below that hardcoded "just model" needed updating (`--allow-test-change`, same
// decisions log).
describe("the interview asks only what changes the generated code, and never a credential", () => {
  test("step order is model then productivity", () => {
    expect([...INTERVIEW_STEP_ORDER]).toEqual(["model", "productivity"]);
  });

  test("questions carry prompts + choices; no free-text or credential questions exist", () => {
    for (const step of INTERVIEW_STEP_ORDER) {
      const q = questionFor(step);
      expect(q.step).toBe(step);
      expect(q.choices?.length).toBeGreaterThan(0);
    }
    expect(questionFor("model").choices?.map((c) => c.value)).toEqual(["openai", "anthropic", "gemini", "ollama"]);
    expect(questionFor("productivity").choices?.map((c) => c.value)).toEqual(["no", "yes"]);
  });
});

describe("the interview is complete once both steps are answered", () => {
  test("answering model then productivity completes the interview", () => {
    let a: InterviewAnswers = {};
    expect(nextStep(a)).toBe("model");
    a = must(applyAnswer(a, "model", openai));
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

  test("assertComplete throws naming productivity once model is answered but productivity isn't", () => {
    expect(() => assertComplete({ model: openai })).toThrow(/"productivity" hasn't been answered/);
  });

  test("assertComplete passes once both steps are answered", () => {
    expect(() => assertComplete({ model: openai, productivity: noProductivity })).not.toThrow();
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

  test("defaults: openai, productivity off", () => {
    expect(DEFAULT_ANSWERS).toEqual({ model: openai, productivity: noProductivity });
  });

  test("skipping every step completes the interview with the defaults", () => {
    let a: InterviewAnswers = {};
    while (!isComplete(a)) a = must(skipStep(a, nextStep(a)!));
    expect(a).toEqual({ model: openai, productivity: noProductivity });
  });
});
