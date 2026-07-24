import { describe, expect, test } from "vitest";
import {
  applyAnswer,
  assertComplete,
  DEFAULT_ANSWERS,
  goBack,
  INTERVIEW_STEP_ORDER,
  isApplicable,
  isComplete,
  nextQuestion,
  nextStep,
  questionFor,
  REFERENCE_SKILLS,
  skillsOf,
  skipStep,
  type InterviewAnswers,
} from "./interview.js";

function must(r: ReturnType<typeof applyAnswer>): InterviewAnswers {
  if (!r.ok) throw new Error(`test setup: ${r.errors.join(", ")}`);
  return r.answers;
}

const openai = { provider: "openai" } as const;

describe("the interview asks only what changes the generated code, and never a credential", () => {
  test("step order is model -> tools -> skills", () => {
    expect([...INTERVIEW_STEP_ORDER]).toEqual(["model", "tools", "skills"]);
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

  test("skills offered are the shipped reference skills, no 'none' entry (an empty pick means none)", () => {
    expect(questionFor("skills").choices?.map((c) => c.value)).toEqual([...REFERENCE_SKILLS]);
  });
});

describe("skills only apply once a Shopify store is connected", () => {
  test("isApplicable: skills need tools=shopify; other steps always apply", () => {
    expect(isApplicable("model", {})).toBe(true);
    expect(isApplicable("tools", {})).toBe(true);
    expect(isApplicable("skills", {})).toBe(false);
    expect(isApplicable("skills", { tools: { kind: "none" } })).toBe(false);
    expect(isApplicable("skills", { tools: { kind: "shopify" } })).toBe(true);
  });

  test("no store: the interview is complete after model + tools (skills never asked)", () => {
    let a: InterviewAnswers = {};
    expect(nextStep(a)).toBe("model");
    a = must(applyAnswer(a, "model", openai));
    expect(nextQuestion(a)?.step).toBe("tools");
    a = must(applyAnswer(a, "tools", { kind: "none" }));
    expect(nextStep(a)).toBeNull();
    expect(nextQuestion(a)).toBeNull();
    expect(isComplete(a)).toBe(true);
  });

  test("Shopify: skills are asked next, and the interview isn't complete until they're answered", () => {
    let a = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "tools", { kind: "shopify" }));
    expect(nextStep(a)).toBe("skills");
    expect(isComplete(a)).toBe(false);
    a = must(applyAnswer(a, "skills", { skills: ["orders"] }));
    expect(isComplete(a)).toBe(true);
  });

  test("answering skills without a store is rejected with a clear reason", () => {
    const a = must(applyAnswer({}, "model", openai));
    const r = applyAnswer(must(applyAnswer(a, "tools", { kind: "none" })), "skills", { skills: [] });
    expect(r).toEqual({ ok: false, errors: ['"skills" only applies when a Shopify store is connected.'] });
  });

  test("switching tools away from Shopify drops the skills chosen earlier", () => {
    let a = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "tools", { kind: "shopify" }));
    a = must(applyAnswer(a, "skills", { skills: ["store-info", "orders"] }));
    a = must(applyAnswer(a, "tools", { kind: "none" }));
    expect(a.skills).toBeUndefined();
    expect(isComplete(a)).toBe(true);
  });
});

describe("assertComplete / skillsOf", () => {
  test("assertComplete throws naming the first unanswered applicable step", () => {
    expect(() => assertComplete({})).toThrow(/"model" hasn't been answered/);
    expect(() => assertComplete({ model: openai, tools: { kind: "shopify" } })).toThrow(/"skills" hasn't been answered/);
  });

  test("assertComplete passes for both complete shapes", () => {
    expect(() => assertComplete({ model: openai, tools: { kind: "none" } })).not.toThrow();
    expect(() => assertComplete({ model: openai, tools: { kind: "shopify" }, skills: { skills: [] } })).not.toThrow();
  });

  test("skillsOf returns [] when the step never applied, else the chosen skills", () => {
    expect(skillsOf({ model: openai, tools: { kind: "none" } })).toEqual([]);
    expect(skillsOf({ model: openai, tools: { kind: "shopify" }, skills: { skills: ["orders"] } })).toEqual(["orders"]);
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

  test("skills: must be an array of real skills", () => {
    let a = must(applyAnswer({}, "model", openai));
    a = must(applyAnswer(a, "tools", { kind: "shopify" }));
    expect(applyAnswer(a, "skills", undefined).ok).toBe(false);
    expect(applyAnswer(a, "skills", { skills: "orders" } as never).ok).toBe(false);
    expect(applyAnswer(a, "skills", { skills: ["nope"] } as never)).toEqual({ ok: false, errors: ["skills: unknown skill(s): nope."] });
    expect(applyAnswer(a, "skills", { skills: [...REFERENCE_SKILLS] }).ok).toBe(true);
    expect(applyAnswer(a, "skills", { skills: [] }).ok).toBe(true);
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
    a = must(applyAnswer(a, "skills", { skills: ["orders"] }));
    const back = goBack(a, "tools");
    expect(back).toEqual({ model: openai });
    expect(nextStep(back)).toBe("tools");
  });

  test("defaults: openai, no store, no skills", () => {
    expect(DEFAULT_ANSWERS).toEqual({ model: openai, tools: { kind: "none" }, skills: { skills: [] } });
  });

  test("skipping every applicable step completes the interview with the defaults", () => {
    let a: InterviewAnswers = {};
    while (!isComplete(a)) a = must(skipStep(a, nextStep(a)!));
    expect(a).toEqual({ model: openai, tools: { kind: "none" } });
  });
});
