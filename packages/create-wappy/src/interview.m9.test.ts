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

// M12 removed the interview's "skills" step — `@wappy/harness` ships no reference skills anymore
// (SPEC §6.1/§6.3: generic format-reasoning/grounding-honesty prompting replaces them, for every
// reply regardless of domain), so there's nothing left to offer once a store is connected. This
// file was rewritten accordingly (`--allow-test-change`, SPEC.md decisions log).
describe("the interview asks only what changes the generated code, and never a credential", () => {
  test("step order is model -> tools", () => {
    expect([...INTERVIEW_STEP_ORDER]).toEqual(["model", "tools"]);
  });

  test("questions carry prompts + choices; no free-text or credential questions exist", () => {
    for (const step of INTERVIEW_STEP_ORDER) {
      const q = questionFor(step);
      expect(q.step).toBe(step);
      expect(q.choices?.length).toBeGreaterThan(0);
    }
    expect(questionFor("tools").choices?.map((c) => c.value)).toEqual(["none", "shopify"]);
    expect(questionFor("model").choices?.map((c) => c.value)).toEqual(["openai", "anthropic", "gemini", "ollama"]);
  });
});

describe("both steps always apply (M12: no conditional skills step anymore)", () => {
  test("no store: the interview is complete after model + tools", () => {
    let a: InterviewAnswers = {};
    expect(nextStep(a)).toBe("model");
    a = must(applyAnswer(a, "model", openai));
    expect(nextQuestion(a)?.step).toBe("tools");
    a = must(applyAnswer(a, "tools", { kind: "none" }));
    expect(nextStep(a)).toBeNull();
    expect(nextQuestion(a)).toBeNull();
    expect(isComplete(a)).toBe(true);
  });

  test("Shopify: the interview is complete right after tools too — nothing further to ask", () => {
    let a = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "tools", { kind: "shopify" }));
    expect(nextStep(a)).toBeNull();
    expect(isComplete(a)).toBe(true);
  });
});

describe("assertComplete", () => {
  test("assertComplete throws naming the first unanswered applicable step", () => {
    expect(() => assertComplete({})).toThrow(/"model" hasn't been answered/);
    expect(() => assertComplete({ model: openai })).toThrow(/"tools" hasn't been answered/);
  });

  test("assertComplete passes once both steps are answered", () => {
    expect(() => assertComplete({ model: openai, tools: { kind: "none" } })).not.toThrow();
    expect(() => assertComplete({ model: openai, tools: { kind: "shopify" } })).not.toThrow();
  });
});

describe("applyAnswer validation", () => {
  test("steps must be answered in order", () => {
    const r = applyAnswer({}, "tools", { kind: "none" });
    expect(r).toEqual({ ok: false, errors: ['Steps must be answered in order — next step is "model", not "tools".'] });
  });

  test("an already-answered step can be revised in place", () => {
    const a = must(applyAnswer({}, "model", openai));
    const revised = must(applyAnswer(a, "model", { provider: "anthropic" }));
    expect(revised.model).toEqual({ provider: "anthropic" });
  });

  test("a missing model provider is rejected", () => {
    const r = applyAnswer({}, "model", {} as never);
    expect(r.ok).toBe(false);
  });

  test("tools: missing or unknown kind is rejected; openapi is no longer an option", () => {
    const a = must(applyAnswer({}, "model", openai));
    expect(applyAnswer(a, "tools", undefined)).toEqual({ ok: false, errors: ["tools: a choice is required."] });
    expect(applyAnswer(a, "tools", { kind: "openapi", source: "x" } as never)).toEqual({ ok: false, errors: ['tools: unknown kind "openapi".'] });
  });

  test("a rejected answer leaves answers untouched", () => {
    const before: InterviewAnswers = { model: openai };
    const r = applyAnswer(before, "tools", { kind: "bogus" } as never);
    expect(r.ok).toBe(false);
    expect(before).toEqual({ model: openai });
  });
});

describe("goBack / skipStep / defaults", () => {
  test("goBack clears the target step and everything after it, keeping earlier answers", () => {
    let a = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "tools", { kind: "shopify" }));
    const back = goBack(a, "tools");
    expect(back).toEqual({ model: openai });
    expect(nextStep(back)).toBe("tools");
  });

  test("defaults: openai, no store", () => {
    expect(DEFAULT_ANSWERS).toEqual({ model: openai, tools: { kind: "none" } });
  });

  test("skipping every applicable step completes the interview with the defaults", () => {
    let a: InterviewAnswers = {};
    while (!isComplete(a)) a = must(skipStep(a, nextStep(a)!));
    expect(a).toEqual({ model: openai, tools: { kind: "none" } });
  });
});
