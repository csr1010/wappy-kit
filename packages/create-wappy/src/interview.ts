/**
 * The `create-wappy` install interview (M9 T9.1, SPEC.md §4.1) as a **pure state machine**: no I/O,
 * no prompts library, no filesystem — just `InterviewAnswers -> next question | done`, so the whole
 * flow (including invalid-combo rejection and back/skip) is testable without a TTY. A thin
 * `@clack/prompts` layer (not built yet — a later T9.1 sub-step) renders `questionFor()`'s data and
 * feeds the human's choice into `applyAnswer()`; T9.2's non-interactive mode drives the exact same
 * functions from flags/env instead of a human, per the milestone brief's "same code path as
 * interactive."
 *
 * Design note (deviation from the brief's literal `(answers, step) -> next question | done`
 * signature): `step` is dropped as an explicit parameter. §4.1's 7 questions have a single fixed
 * order, so which step comes next is always fully determined by which steps in `answers` are
 * already filled — carrying a separate `step` cursor that could drift out of sync with `answers`
 * (e.g. after `goBack`) would be a second source of truth for the same fact. `nextStep(answers)`
 * derives it fresh every call instead.
 */

export type ModelProvider = "openai" | "anthropic" | "gemini" | "ollama";
export interface ModelAnswer {
  provider: ModelProvider;
}

export type FrameworkChoice = "none" | "mastra" | "vercel-ai-sdk" | "langgraph";
export interface FrameworkAnswer {
  framework: FrameworkChoice;
}

/** The reference skills v0.1 actually ships (§4.1 step 3: "v0.1 ships a couple") — matches
 * `@wappy/harness`'s `STORE_INFO_SKILL`/`createOrdersSkill` exactly; NOT an open-ended list (no
 * downloading external skills yet, per spec). */
export const REFERENCE_SKILLS = ["store-info", "orders"] as const;
export type ReferenceSkillName = (typeof REFERENCE_SKILLS)[number];
export interface SkillsAnswer {
  /** Empty array = "none". */
  skills: ReferenceSkillName[];
}

export type ToolsAnswer = { kind: "none" } | { kind: "openapi"; source: string } | { kind: "shopify"; storeDomain: string };

export type MemoryBackend = "local" | "mem0" | "cognee" | "postgres";
export interface MemoryAnswer {
  backend: MemoryBackend;
}

/** Jev requires a key path (the invalid-combo example the milestone brief names explicitly) —
 * modeled as a required field on the `jev` variant itself, so "Jev without a key path" is
 * unrepresentable in a well-typed answer and only reachable via `applyAnswer`'s runtime validation
 * (e.g. a non-interactive flag combo), not a gap in the type. */
export type RouterAnswer = { router: "llm" } | { router: "jev"; jevKeyPath: string };

export type WhatsAppAnswer = { mode: "later" } | { mode: "now"; phoneNumberId: string; accessToken: string; verifyToken: string };

export interface InterviewAnswers {
  model?: ModelAnswer;
  framework?: FrameworkAnswer;
  skills?: SkillsAnswer;
  tools?: ToolsAnswer;
  memory?: MemoryAnswer;
  router?: RouterAnswer;
  whatsapp?: WhatsAppAnswer;
}

export const INTERVIEW_STEP_ORDER = ["model", "framework", "skills", "tools", "memory", "router", "whatsapp"] as const;
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
  framework: {
    step: "framework",
    prompt: "Do you already use an agent framework?",
    choices: [
      { value: "none", label: "None — set up Vercel AI SDK for me" },
      { value: "mastra", label: "I use Mastra" },
      { value: "vercel-ai-sdk", label: "I use Vercel AI SDK" },
      { value: "langgraph", label: "I use LangGraph" },
    ],
  },
  skills: {
    step: "skills",
    prompt: "Which reference skills should be included?",
    choices: [
      { value: "none", label: "None" },
      { value: "store-info", label: "Store info (hours, location, policies via RAG)" },
      { value: "orders", label: "Orders (order status via tools)" },
    ],
  },
  tools: {
    step: "tools",
    prompt: "Do you have an OpenAPI/Swagger spec or a Shopify store to connect?",
    choices: [
      { value: "none", label: "None" },
      { value: "openapi", label: "OpenAPI/Swagger (paste a spec URL or file path)" },
      { value: "shopify", label: "Shopify" },
    ],
  },
  memory: {
    step: "memory",
    prompt: "Which memory backend?",
    choices: [
      { value: "local", label: "Local file (default)" },
      { value: "mem0", label: "Mem0" },
      { value: "cognee", label: "Cognee" },
      { value: "postgres", label: "Postgres" },
    ],
  },
  router: {
    step: "router",
    prompt: "Which router?",
    choices: [
      { value: "llm", label: "LLM (default)" },
      { value: "jev", label: "Jev (optional System-One backend)" },
    ],
  },
  whatsapp: {
    step: "whatsapp",
    prompt: "Enter WhatsApp Cloud API credentials now, or later?",
    choices: [
      { value: "now", label: "Now" },
      { value: "later", label: "Later" },
    ],
  },
};

/** Pure per-step data for a thin prompts layer to render — never does any I/O itself. */
export function questionFor(step: InterviewStepId): InterviewQuestionMeta {
  return QUESTIONS[step];
}

/** The first step in canonical order whose answer isn't filled yet, or `null` once every step is
 * answered (the interview is done). Order is always derived from `answers` itself — see the
 * file-level design note on why there's no separate step cursor. */
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

/** Every step's answer is present — the shape the generators (T9.3) require. */
export type CompleteInterviewAnswers = Required<InterviewAnswers>;

/** Narrows `answers` to `CompleteInterviewAnswers`, throwing a clear error if any step is still
 * unanswered — generation should never silently proceed on a partial interview. */
export function assertComplete(answers: InterviewAnswers): asserts answers is CompleteInterviewAnswers {
  const missing = nextStep(answers);
  if (missing !== null) throw new Error(`Interview is incomplete — "${missing}" hasn't been answered yet.`);
}

function nonEmpty(s: string | undefined, label: string): string[] {
  return s && s.trim().length > 0 ? [] : [`${label} is required and cannot be empty.`];
}

/** Validates one step's answer value in isolation (never looks at other steps' answers — each
 * step's validity only depends on itself, per §4.1's own per-question invalid-combo examples). */
function validateAnswer(step: InterviewStepId, value: InterviewAnswers[InterviewStepId]): string[] {
  switch (step) {
    case "model":
      return value && "provider" in (value as ModelAnswer) ? [] : ["model: a provider is required."];
    case "framework":
      return value && "framework" in (value as FrameworkAnswer) ? [] : ["framework: a choice is required."];
    case "skills": {
      const v = value as SkillsAnswer | undefined;
      if (!v || !Array.isArray(v.skills)) return ["skills: an array (possibly empty) is required."];
      const unknown = v.skills.filter((s) => !(REFERENCE_SKILLS as readonly string[]).includes(s));
      return unknown.length > 0 ? [`skills: unknown reference skill(s): ${unknown.join(", ")}.`] : [];
    }
    case "tools": {
      const v = value as ToolsAnswer | undefined;
      if (!v) return ["tools: a choice is required."];
      if (v.kind === "none") return [];
      if (v.kind === "openapi") return nonEmpty(v.source, "tools.source");
      if (v.kind === "shopify") return nonEmpty(v.storeDomain, "tools.storeDomain");
      return [`tools: unknown kind "${(v as { kind: string }).kind}".`];
    }
    case "memory":
      return value && "backend" in (value as MemoryAnswer) ? [] : ["memory: a backend is required."];
    case "router": {
      const v = value as RouterAnswer | undefined;
      if (!v) return ["router: a choice is required."];
      if (v.router === "llm") return [];
      if (v.router === "jev") return nonEmpty(v.jevKeyPath, "router.jevKeyPath (Jev requires a key path)");
      return [`router: unknown value "${(v as { router: string }).router}".`];
    }
    case "whatsapp": {
      const v = value as WhatsAppAnswer | undefined;
      if (!v) return ["whatsapp: a choice is required."];
      if (v.mode === "later") return [];
      if (v.mode === "now") {
        return [...nonEmpty(v.phoneNumberId, "whatsapp.phoneNumberId"), ...nonEmpty(v.accessToken, "whatsapp.accessToken"), ...nonEmpty(v.verifyToken, "whatsapp.verifyToken")];
      }
      return [`whatsapp: unknown mode "${(v as { mode: string }).mode}".`];
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
 * that hasn't been reached yet (skipping ahead out of order) is rejected, since a later step's
 * validity can't be meaningfully judged before earlier ones are settled. Invalid values for the
 * step itself (e.g. Jev without a key path) are rejected with a clear error, and `answers` is
 * returned unchanged in both rejection cases — this function never produces a partially-invalid
 * state.
 */
export function applyAnswer(answers: InterviewAnswers, step: InterviewStepId, value: InterviewAnswers[InterviewStepId]): ApplyAnswerOk | ApplyAnswerError {
  const current = nextStep(answers);
  const alreadyAnswered = answers[step] !== undefined;
  if (step !== current && !alreadyAnswered) {
    return { ok: false, errors: [`Steps must be answered in order — next step is "${current}", not "${step}".`] };
  }
  const errors = validateAnswer(step, value);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, answers: { ...answers, [step]: value } };
}

/** Clears `fromStep` and every step after it in canonical order, so `nextStep()` returns to
 * `fromStep` — the interview's "go back and change an earlier answer" affordance. Steps before
 * `fromStep` are left untouched. */
export function goBack(answers: InterviewAnswers, fromStep: InterviewStepId): InterviewAnswers {
  const idx = INTERVIEW_STEP_ORDER.indexOf(fromStep);
  const next = { ...answers };
  for (let i = idx; i < INTERVIEW_STEP_ORDER.length; i++) delete next[INTERVIEW_STEP_ORDER[i]!];
  return next;
}

/** The answer each step takes when a human/flag explicitly skips it — always the spec's own stated
 * default (§4.1: "if none, scaffold default"; memory "local file (default)"; router "LLM
 * (default)"; whatsapp "later"). `skills`/`tools` have no spec-stated default beyond "none", which
 * doubles as their skip value. Exposed so T9.2's non-interactive mode and a CLI's literal
 * "press Enter to skip" both reuse the exact same values instead of each hardcoding their own. */
export const DEFAULT_ANSWERS: { [S in InterviewStepId]: NonNullable<InterviewAnswers[S]> } = {
  model: { provider: "openai" },
  framework: { framework: "none" },
  skills: { skills: [] },
  tools: { kind: "none" },
  memory: { backend: "local" },
  router: { router: "llm" },
  whatsapp: { mode: "later" },
};

/** Applies `step`'s spec-stated default answer (see `DEFAULT_ANSWERS`) — the pure implementation of
 * "skip this question." */
export function skipStep(answers: InterviewAnswers, step: InterviewStepId): ApplyAnswerOk | ApplyAnswerError {
  return applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
}
