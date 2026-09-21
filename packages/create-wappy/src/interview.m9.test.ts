import { describe, expect, test } from "vitest";
import {
  applyAnswer,
  DEFAULT_ANSWERS,
  goBack,
  INTERVIEW_STEP_ORDER,
  isComplete,
  type InterviewAnswers,
  nextQuestion,
  nextStep,
  questionFor,
  REFERENCE_SKILLS,
  skipStep,
} from "./interview.js";

describe("nextStep / nextQuestion / isComplete — pure position derivation", () => {
  test("an empty answers object starts at 'model', the first §4.1 step", () => {
    expect(nextStep({})).toBe("model");
    expect(nextQuestion({})?.step).toBe("model");
    expect(isComplete({})).toBe(false);
  });

  test("walks all 7 steps in §4.1's exact order as each is answered", () => {
    let answers: InterviewAnswers = {};
    const seen: string[] = [];
    for (const step of INTERVIEW_STEP_ORDER) {
      expect(nextStep(answers)).toBe(step);
      seen.push(step);
      const result = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
      expect(result.ok).toBe(true);
      if (result.ok) answers = result.answers;
    }
    expect(seen).toEqual(["model", "framework", "skills", "tools", "memory", "router", "whatsapp"]);
    expect(nextStep(answers)).toBeNull();
    expect(nextQuestion(answers)).toBeNull();
    expect(isComplete(answers)).toBe(true);
  });

  test("questionFor returns stable prompt/choices data for every step, with no I/O", () => {
    for (const step of INTERVIEW_STEP_ORDER) {
      const q = questionFor(step);
      expect(q.step).toBe(step);
      expect(q.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("applyAnswer — ordering discipline", () => {
  test("rejects answering a step before its predecessors are answered (no skipping ahead)", () => {
    const result = applyAnswer({}, "framework", DEFAULT_ANSWERS.framework);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/next step is "model"/);
  });

  test("allows re-answering an already-answered step (revising after a back)", () => {
    const r1 = applyAnswer({}, "model", { provider: "openai" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("unreachable");
    const r2 = applyAnswer(r1.answers, "model", { provider: "anthropic" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("unreachable");
    expect(r2.answers.model).toEqual({ provider: "anthropic" });
  });

  test("an invalid value leaves answers completely unchanged, not partially applied", () => {
    const before: InterviewAnswers = {};
    const result = applyAnswer(before, "model", undefined as never);
    expect(result.ok).toBe(false);
    expect(before).toEqual({});
  });
});

describe("applyAnswer — invalid combos blocked", () => {
  test("Jev router without a key path is rejected (the milestone brief's own named example)", () => {
    let answers: InterviewAnswers = {};
    for (const step of ["model", "framework", "skills", "tools", "memory"] as const) {
      const r = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
      if (r.ok) answers = r.answers;
    }
    const result = applyAnswer(answers, "router", { router: "jev", jevKeyPath: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/jevKeyPath/);
  });

  test("Jev router WITH a key path is accepted", () => {
    let answers: InterviewAnswers = {};
    for (const step of ["model", "framework", "skills", "tools", "memory"] as const) {
      const r = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
      if (r.ok) answers = r.answers;
    }
    const result = applyAnswer(answers, "router", { router: "jev", jevKeyPath: "/keys/jev.json" });
    expect(result.ok).toBe(true);
  });

  test("tools=openapi without a source is rejected; tools=shopify without a storeDomain is rejected", () => {
    const answers = fillThrough("skills");
    expect(applyAnswer(answers, "tools", { kind: "openapi", source: "" }).ok).toBe(false);
    expect(applyAnswer(answers, "tools", { kind: "openapi", source: "   " }).ok).toBe(false);
    expect(applyAnswer(answers, "tools", { kind: "shopify", storeDomain: "" }).ok).toBe(false);
    expect(applyAnswer(answers, "tools", { kind: "shopify", storeDomain: "my-shop.myshopify.com" }).ok).toBe(true);
  });

  test("skills answer rejects an unknown reference skill name", () => {
    const answers = fillThrough("framework");
    const result = applyAnswer(answers, "skills", { skills: ["not-a-real-skill" as never] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/unknown reference skill/);
  });

  test("skills answer accepts any combination of the real REFERENCE_SKILLS", () => {
    const answers = fillThrough("framework");
    expect(applyAnswer(answers, "skills", { skills: [...REFERENCE_SKILLS] }).ok).toBe(true);
    expect(applyAnswer(answers, "skills", { skills: [] }).ok).toBe(true);
  });

  test("whatsapp mode=now without full credentials is rejected; each missing field surfaces its own error", () => {
    const answers = fillThrough("router");
    const result = applyAnswer(answers, "whatsapp", { mode: "now", phoneNumberId: "", accessToken: "", verifyToken: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
      expect(result.errors.join(" ")).toMatch(/phoneNumberId/);
      expect(result.errors.join(" ")).toMatch(/accessToken/);
      expect(result.errors.join(" ")).toMatch(/verifyToken/);
    }
  });

  test("whatsapp mode=now with full credentials is accepted", () => {
    const answers = fillThrough("router");
    const result = applyAnswer(answers, "whatsapp", { mode: "now", phoneNumberId: "106540352242922", accessToken: "EAAtest", verifyToken: "my-verify-token" });
    expect(result.ok).toBe(true);
  });
});

describe("goBack — revise an earlier answer", () => {
  test("clears the target step and every step after it, keeping earlier steps intact", () => {
    let answers: InterviewAnswers = {};
    for (const step of INTERVIEW_STEP_ORDER) {
      const r = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
      if (r.ok) answers = r.answers;
    }
    expect(isComplete(answers)).toBe(true);

    const rewound = goBack(answers, "memory");
    expect(rewound.model).toEqual(DEFAULT_ANSWERS.model);
    expect(rewound.framework).toEqual(DEFAULT_ANSWERS.framework);
    expect(rewound.skills).toEqual(DEFAULT_ANSWERS.skills);
    expect(rewound.tools).toEqual(DEFAULT_ANSWERS.tools);
    expect(rewound.memory).toBeUndefined();
    expect(rewound.router).toBeUndefined();
    expect(rewound.whatsapp).toBeUndefined();
    expect(nextStep(rewound)).toBe("memory");
  });

  test("going back to the very first step clears everything", () => {
    let answers: InterviewAnswers = {};
    for (const step of INTERVIEW_STEP_ORDER) {
      const r = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
      if (r.ok) answers = r.answers;
    }
    expect(goBack(answers, "model")).toEqual({});
  });
});

describe("skipStep — applies the spec-stated default for a step", () => {
  test("skipping every step end to end completes the interview with all spec-stated defaults", () => {
    let answers: InterviewAnswers = {};
    for (const step of INTERVIEW_STEP_ORDER) {
      const r = skipStep(answers, step);
      expect(r.ok).toBe(true);
      if (r.ok) answers = r.answers;
    }
    expect(answers).toEqual(DEFAULT_ANSWERS);
    expect(isComplete(answers)).toBe(true);
  });
});

function fillThrough(lastStep: (typeof INTERVIEW_STEP_ORDER)[number]): InterviewAnswers {
  let answers: InterviewAnswers = {};
  for (const step of INTERVIEW_STEP_ORDER) {
    const r = applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
    if (r.ok) answers = r.answers;
    if (step === lastStep) break;
  }
  return answers;
}
