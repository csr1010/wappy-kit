import {
  applyAnswer,
  assertComplete,
  DEFAULT_ANSWERS,
  INTERVIEW_STEP_ORDER,
  REFERENCE_SKILLS,
  type CompleteInterviewAnswers,
  type FrameworkChoice,
  type InterviewAnswers,
  type InterviewStepId,
  type MemoryBackend,
  type ModelProvider,
  type ReferenceSkillName,
} from "./interview.js";

/**
 * T9.2 non-interactive mode: the exact same interview, driven by flags/env/piped answers instead of
 * a human — "same code path as interactive" per the milestone brief means literally reusing
 * `applyAnswer()` for every step's validation (invalid combos are rejected identically either way),
 * not a parallel set of rules. This module's own job is narrower: map raw string flag values into
 * the typed `Answer` shapes `applyAnswer` expects, so a CLI's `--model openai` and an interactive
 * pick of "OpenAI" produce byte-identical `InterviewAnswers`.
 */

export interface NonInteractiveFlags {
  /** Accept the spec-stated default (`DEFAULT_ANSWERS`) for any step whose flag is omitted. */
  yes?: boolean;
  model?: string;
  framework?: string;
  /** Comma-separated reference skill names, or "none". */
  skills?: string;
  /** "none" | "shopify" | an OpenAPI/Swagger source (URL or file path). */
  api?: string;
  shopifyStoreDomain?: string;
  memory?: string;
  router?: string;
  jevKeyPath?: string;
  /** "now" | "later". */
  whatsapp?: string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  whatsappVerifyToken?: string;
}

export type NonInteractiveResult = { ok: true; answers: CompleteInterviewAnswers } | { ok: false; errors: string[] };

function isModelProvider(v: string): v is ModelProvider {
  return v === "openai" || v === "anthropic" || v === "gemini" || v === "ollama";
}
function isFrameworkChoice(v: string): v is FrameworkChoice {
  return v === "none" || v === "mastra" || v === "vercel-ai-sdk" || v === "langgraph";
}
function isMemoryBackend(v: string): v is MemoryBackend {
  return v === "local" || v === "mem0" || v === "cognee" || v === "postgres";
}
function isReferenceSkillName(v: string): v is ReferenceSkillName {
  return (REFERENCE_SKILLS as readonly string[]).includes(v);
}

/** One step's raw-flag-to-typed-Answer mapping. `undefined` = the flag wasn't given (caller decides
 * whether that's an error or falls back to `--yes`'s default); a pushed error means the flag WAS
 * given but couldn't be parsed into a valid shape at all (e.g. an unrecognized enum value) — a
 * distinct, earlier failure mode than `applyAnswer`'s own semantic validation (e.g. Jev without a
 * key path), which still runs afterward on whatever this produces. */
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
    case "framework": {
      if (flags.framework === undefined) return undefined;
      if (!isFrameworkChoice(flags.framework)) {
        errors.push(`--framework must be one of none|mastra|vercel-ai-sdk|langgraph, got "${flags.framework}".`);
        return undefined;
      }
      return { framework: flags.framework };
    }
    case "skills": {
      if (flags.skills === undefined) return undefined;
      if (flags.skills === "none" || flags.skills.trim() === "") return { skills: [] };
      const names = flags.skills.split(",").map((s) => s.trim());
      const unknown = names.filter((n) => !isReferenceSkillName(n));
      if (unknown.length > 0) {
        errors.push(`--skills has unknown reference skill(s): ${unknown.join(", ")}. Valid: ${REFERENCE_SKILLS.join(", ")}, or "none".`);
        return undefined;
      }
      return { skills: names as ReferenceSkillName[] };
    }
    case "tools": {
      if (flags.api === undefined) return undefined;
      if (flags.api === "none") return { kind: "none" };
      if (flags.api === "shopify") {
        if (!flags.shopifyStoreDomain) {
          errors.push('--api shopify requires --shopify-store-domain.');
          return undefined;
        }
        return { kind: "shopify", storeDomain: flags.shopifyStoreDomain };
      }
      return { kind: "openapi", source: flags.api };
    }
    case "memory": {
      if (flags.memory === undefined) return undefined;
      if (!isMemoryBackend(flags.memory)) {
        errors.push(`--memory must be one of local|mem0|cognee|postgres, got "${flags.memory}".`);
        return undefined;
      }
      return { backend: flags.memory };
    }
    case "router": {
      if (flags.router === undefined) return undefined;
      if (flags.router === "llm") return { router: "llm" };
      if (flags.router === "jev") return { router: "jev", jevKeyPath: flags.jevKeyPath ?? "" };
      errors.push(`--router must be one of llm|jev, got "${flags.router}".`);
      return undefined;
    }
    case "whatsapp": {
      if (flags.whatsapp === undefined) return undefined;
      if (flags.whatsapp === "later") return { mode: "later" };
      if (flags.whatsapp === "now") {
        return {
          mode: "now",
          phoneNumberId: flags.whatsappPhoneNumberId ?? "",
          accessToken: flags.whatsappAccessToken ?? "",
          verifyToken: flags.whatsappVerifyToken ?? "",
        };
      }
      errors.push(`--whatsapp must be one of now|later, got "${flags.whatsapp}".`);
      return undefined;
    }
  }
}

/**
 * Resolves a complete, validated `InterviewAnswers` from flags — the same validation as the
 * interactive interview (`applyAnswer`), just fed all at once instead of turn by turn. Collects
 * every error across every step in one pass (a non-interactive caller can't "ask again" for just
 * the one bad flag, so reporting everything wrong up front matters more here than in the
 * interactive path).
 */
export function resolveNonInteractiveAnswers(flags: NonInteractiveFlags): NonInteractiveResult {
  const errors: string[] = [];
  let answers: InterviewAnswers = {};

  for (const step of INTERVIEW_STEP_ORDER) {
    const errorCountBefore = errors.length;
    const parsed = resolveStepAnswer(step, flags, errors);
    const stepHadParseError = errors.length > errorCountBefore;
    if (stepHadParseError) continue; // already recorded a specific error for this step

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
