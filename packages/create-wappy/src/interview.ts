/**
 * The `create-wappy` install interview (M9 T9.1, SPEC.md §4.1) as a **pure state machine**: no I/O,
 * no prompts library, no filesystem — just `InterviewAnswers -> next question | done`, so the whole
 * flow (including invalid-combo rejection and back/skip) is testable without a TTY. A thin
 * `@clack/prompts` layer renders `questionFor()`'s data and feeds the human's choice into
 * `applyAnswer()`; non-interactive mode drives the exact same functions from flags instead.
 *
 * v0.1 asks only what genuinely changes the generated code, and never asks for a credential
 * (secrets go in `.env`, filled in from the generated `.env.sample`):
 *   1. model provider
 *   2. tools — none, or a Shopify store (the one connector we ship)
 * A "skills" step used to sit here (M8/M9) offering three hand-authored, Shopify-flavored
 * reference skills. M12 removed it: `@wappy/harness` ships no reference skills anymore — the
 * generic format-reasoning + grounding-honesty prompting (SPEC §6.1/§6.3) applies to every reply
 * regardless of domain, so there's nothing left for this step to offer.
 * Memory (local SQLite/LibSQL), the router (LLM) and the agent framework (Vercel AI SDK) are fixed
 * in v0.1: the alternatives aren't implemented, and an option that can't be generated shouldn't be
 * in the menu.
 *
 * Design note: `step` is not an explicit parameter — which step comes next is fully determined by
 * which steps in `answers` are already filled, so `nextStep(answers)` derives it fresh every call
 * rather than carrying a cursor that could drift out of sync after `goBack`.
 */

export type ModelProvider = "openai" | "anthropic" | "gemini" | "ollama";
export interface ModelAnswer {
  provider: ModelProvider;
}

/** No store domain here on purpose: it's configuration, not an interview answer — it lives in
 * `.env` as SHOPIFY_STORE_DOMAIN (see `.env.sample`). */
export type ToolsAnswer = { kind: "none" } | { kind: "shopify" };

export interface InterviewAnswers {
  model?: ModelAnswer;
  tools?: ToolsAnswer;
}

export const INTERVIEW_STEP_ORDER = ["model", "tools"] as const;
export type InterviewStepId = (typeof INTERVIEW_STEP_ORDER)[number];

export interface InterviewQuestionMeta {
  step: InterviewStepId;
  prompt: string;
  choices?: { value: string; label: string }[];
}

const QUESTIONS: Record<InterviewStepId, InterviewQuestionMeta> = {
  model: {
    step: "model",
    prompt: "Which model provider will you use?",
    choices: [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "gemini", label: "Gemini" },
      { value: "ollama", label: "Local Ollama" },
    ],
  },
  tools: {
    step: "tools",
    prompt: "Connect a store so the agent can call its API?",
    choices: [
      { value: "none", label: "No — skip for now" },
      { value: "shopify", label: "Shopify" },
    ],
  },
};

/** Pure per-step data for a thin prompts layer to render — never does any I/O itself. */
export function questionFor(step: InterviewStepId): InterviewQuestionMeta {
  return QUESTIONS[step];
}

/** The first step in canonical order whose answer isn't filled yet, or `null` once every step is
 * answered (the interview is done). Both remaining steps (`model`, `tools`) always apply — the M9
 * "skills" step this used to skip conditionally on was removed in M12, along with the
 * `isApplicable` indirection that existed only to support that conditional. */
export function nextStep(answers: InterviewAnswers): InterviewStepId | null {
  for (const step of INTERVIEW_STEP_ORDER) {
    if (answers[step] === undefined) return step;
  }
  return null;
}

/** Convenience wrapper combining `nextStep` + `questionFor` — `null` means the interview is done. */
export function nextQuestion(answers: InterviewAnswers): InterviewQuestionMeta | null {
  const step = nextStep(answers);
  return step === null ? null : questionFor(step);
}

export function isComplete(answers: InterviewAnswers): boolean {
  return nextStep(answers) === null;
}

/** What the generators (T9.3) require. */
export interface CompleteInterviewAnswers {
  model: ModelAnswer;
  tools: ToolsAnswer;
}

/** Narrows `answers` to `CompleteInterviewAnswers`, throwing a clear error if any applicable step
 * is still unanswered — generation should never silently proceed on a partial interview. */
export function assertComplete(answers: InterviewAnswers): asserts answers is CompleteInterviewAnswers {
  const missing = nextStep(answers);
  if (missing !== null) throw new Error(`Interview is incomplete — "${missing}" hasn't been answered yet.`);
}

/** Validates one step's answer value in isolation (each step's validity depends only on itself). */
function validateAnswer(step: InterviewStepId, value: InterviewAnswers[InterviewStepId]): string[] {
  switch (step) {
    case "model":
      return value && "provider" in (value as ModelAnswer) ? [] : ["model: a provider is required."];
    case "tools": {
      const v = value as ToolsAnswer | undefined;
      if (!v) return ["tools: a choice is required."];
      if (v.kind === "none" || v.kind === "shopify") return [];
      return [`tools: unknown kind "${(v as { kind: string }).kind}".`];
    }
  }
}

export interface ApplyAnswerOk {
  ok: true;
  answers: InterviewAnswers;
}
export interface ApplyAnswerError {
  ok: false;
  errors: string[];
}

/**
 * Applies one answer for `step`. Allowed when `step` is the interview's current `nextStep`
 * (answering forward) OR `step` is already answered (revising after a `goBack`) — answering a step
 * that hasn't been reached yet is rejected. Invalid values are rejected with a clear error and
 * `answers` is returned unchanged — this function never produces a partially-invalid state.
 */
export function applyAnswer(answers: InterviewAnswers, step: InterviewStepId, value: InterviewAnswers[InterviewStepId]): ApplyAnswerOk | ApplyAnswerError {
  const current = nextStep(answers);
  const alreadyAnswered = answers[step] !== undefined;
  if (step !== current && !alreadyAnswered) {
    return { ok: false, errors: [`Steps must be answered in order — next step is "${current}", not "${step}".`] };
  }
  const errors = validateAnswer(step, value);
  if (errors.length > 0) return { ok: false, errors };
  const next: InterviewAnswers = { ...answers, [step]: value };
  return { ok: true, answers: next };
}

/** Clears `fromStep` and every step after it in canonical order, so `nextStep()` returns to
 * `fromStep` — the interview's "go back and change an earlier answer" affordance. */
export function goBack(answers: InterviewAnswers, fromStep: InterviewStepId): InterviewAnswers {
  const idx = INTERVIEW_STEP_ORDER.indexOf(fromStep);
  const next = { ...answers };
  for (let i = idx; i < INTERVIEW_STEP_ORDER.length; i++) delete next[INTERVIEW_STEP_ORDER[i]!];
  return next;
}

/** The answer each step takes when a human/flag explicitly skips it. Exposed so non-interactive
 * mode and a CLI's "press Enter to skip" reuse the same values instead of each hardcoding their own. */
export const DEFAULT_ANSWERS: { [S in InterviewStepId]: NonNullable<InterviewAnswers[S]> } = {
  model: { provider: "openai" },
  tools: { kind: "none" },
};

/** Applies `step`'s default answer (see `DEFAULT_ANSWERS`) — the pure implementation of "skip". */
export function skipStep(answers: InterviewAnswers, step: InterviewStepId): ApplyAnswerOk | ApplyAnswerError {
  return applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
}
