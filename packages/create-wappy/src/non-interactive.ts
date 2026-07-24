import {
  applyAnswer,
  assertComplete,
  DEFAULT_ANSWERS,
  INTERVIEW_STEP_ORDER,
  type CompleteInterviewAnswers,
  type InterviewAnswers,
  type InterviewStepId,
  type ModelProvider,
} from "./interview.js";

/**
 * T9.2 non-interactive mode: the exact same interview, driven by flags instead of a human — "same
 * code path as interactive" means literally reusing `applyAnswer()` for every step's validation, not
 * a parallel set of rules. This module's own job is narrower: map raw string flag values into the
 * typed answer shapes `applyAnswer` expects, so `--model openai` and an interactive pick of "OpenAI"
 * produce byte-identical `InterviewAnswers`. No credential flags exist: secrets go in `.env`.
 */

export interface NonInteractiveFlags {
  /** Accept the default (`DEFAULT_ANSWERS`) for any step whose flag is omitted. */
  yes?: boolean;
  model?: string;
  /** "none" | "shopify". */
  api?: string;
}

export type NonInteractiveResult = { ok: true; answers: CompleteInterviewAnswers } | { ok: false; errors: string[] };

function isModelProvider(v: string): v is ModelProvider {
  return v === "openai" || v === "anthropic" || v === "gemini" || v === "ollama";
}

/** One step's raw-flag-to-typed-answer mapping. `undefined` = the flag wasn't given; a pushed error
 * means it WAS given but couldn't be parsed at all (e.g. an unrecognized enum value) — an earlier
 * failure mode than `applyAnswer`'s own validation, which still runs on whatever this produces. */
function resolveStepAnswer(step: InterviewStepId, flags: NonInteractiveFlags, errors: string[]): InterviewAnswers[InterviewStepId] {
  switch (step) {
    case "model": {
      if (flags.model === undefined) return undefined;
      if (!isModelProvider(flags.model)) {
        errors.push(`--model must be one of openai|anthropic|gemini|ollama, got "${flags.model}".`);
        return undefined;
      }
      return { provider: flags.model };
    }
    case "tools": {
      if (flags.api === undefined) return undefined;
      if (flags.api === "none") return { kind: "none" };
      if (flags.api === "shopify") return { kind: "shopify" };
      errors.push(`--api must be one of none|shopify, got "${flags.api}".`);
      return undefined;
    }
  }
}

/**
 * Resolves a complete, validated `InterviewAnswers` from flags — the same validation as the
 * interactive interview (`applyAnswer`), just fed all at once. Collects every error across every
 * step in one pass (a non-interactive caller can't "ask again" for just the one bad flag).
 */
export function resolveNonInteractiveAnswers(flags: NonInteractiveFlags): NonInteractiveResult {
  const errors: string[] = [];
  let answers: InterviewAnswers = {};

  for (const step of INTERVIEW_STEP_ORDER) {
    const errorCountBefore = errors.length;
    const parsed = resolveStepAnswer(step, flags, errors);
    if (errors.length > errorCountBefore) continue; // already recorded a specific error for this step

    const value = parsed ?? (flags.yes ? DEFAULT_ANSWERS[step] : undefined);
    if (value === undefined) {
      errors.push(`Missing required flag for step "${step}" (pass it explicitly, or use --yes to accept the default).`);
      continue;
    }
    const result = applyAnswer(answers, step, value);
    if (!result.ok) errors.push(...result.errors);
    else answers = result.answers;
  }

  if (errors.length > 0) return { ok: false, errors };
  assertComplete(answers);
  return { ok: true, answers };
}
