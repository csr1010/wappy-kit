/**
 * The `@wappy_ai/create-agent` install interview (M9 T9.1, SPEC.md §4.1) as a **pure state machine**: no I/O,
 * no prompts library, no filesystem — just `InterviewAnswers -> next question | done`, so the whole
 * flow (including invalid-combo rejection and back/skip) is testable without a TTY. A thin
 * `@clack/prompts` layer renders `questionFor()`'s data and feeds the human's choice into
 * `applyAnswer()`; non-interactive mode drives the exact same functions from flags instead.
 *
 * Asks only what genuinely changes the generated code, and never asks for a credential (secrets go
 * in `.env`, filled in from the generated `.env.sample`): the model provider, where retrieved
 * knowledge/RAG lives (see `MemoryBackendAnswer`), and (added back deliberately, see
 * `ProductivityAnswer`) whether to wire in `@wappy_ai/productivity`.
 *
 * A "tools" step used to sit here (M9), offering a hand-written Shopify connector bundled inside
 * `@wappy_ai/tools-openapi`. Removed entirely (see docs/SPEC.md's decisions log): domain connectors
 * (Shopify and anything else) are out of scope for this open-source repo — they live in a separate
 * connectors repo/npm scope now, built on Composio rather than hand-mapped APIs, and are wired into
 * an agent by hand (`AgentDeps.tools`/`invokeTools`), not through this interview. wappy-kit's own
 * publishable surface is purely the agent OS: core, harness, whatsapp, create-agent, productivity —
 * nothing domain/vendor-specific. A "skills" step (M8/M9, removed in M12) preceded this one; see
 * M12's own history for that removal. Unlike tools/skills, `productivity` is NOT domain-specific
 * (it doesn't know what Google or any vendor is — see `@wappy_ai/productivity`'s own docs), so this
 * doesn't reopen that boundary.
 *
 * Raw conversation history (always local SQLite/LibSQL, `createLibsqlMemory`), the router (LLM) and
 * the agent framework (Vercel AI SDK) are fixed: the alternatives aren't implemented, and an option
 * that can't be generated shouldn't be in the menu. Retrieved knowledge/RAG (a separate concern —
 * see `@wappy_ai/harness`'s `Knowledge` interface) is NOT fixed: `memory` picks its backend.
 *
 * Design note: `step` is not an explicit parameter — which step comes next is fully determined by
 * which steps in `answers` are already filled, so `nextStep(answers)` derives it fresh every call
 * rather than carrying a cursor that could drift out of sync after `goBack`.
 */

export type ModelProvider = "openai" | "anthropic" | "gemini" | "ollama";
export interface ModelAnswer {
  provider: ModelProvider;
}

/** M-productivity: whether to wire in `@wappy_ai/productivity` — a real Gmail/Calendar assistant
 * that answers any question in plain language via read-only, parameterized search tools, once you
 * connect Google (see ARCHITECTURE.md). No fixed command list, no scheduling. A deliberate, direct
 * reversal of the earlier "model-only" simplification: that removal was because there was nothing
 * real behind a second step at the time; there is now. */
export interface ProductivityAnswer {
  enabled: boolean;
}

/** Where retrieved knowledge (anything ingested via @wappy_ai/harness's Knowledge/RAG) lives.
 * "local" (default): @wappy_ai/harness's own createKnowledge, LibSQL-backed, BM25 by default — free,
 * offline, no account. "cognee": a self-hosted or cloud Cognee instance (bring your own, same
 * pattern as Google OAuth) — builds a knowledge graph of entities/relationships rather than literal
 * keyword matching, and is designed to improve itself over repeated ingests. See
 * @wappy_ai/connector-cognee and COGNEE_SETUP.md. */
export interface MemoryBackendAnswer {
  backend: "local" | "cognee";
}

export interface InterviewAnswers {
  model?: ModelAnswer;
  memory?: MemoryBackendAnswer;
  productivity?: ProductivityAnswer;
}

export const INTERVIEW_STEP_ORDER = ["model", "memory", "productivity"] as const;
export type InterviewStepId = (typeof INTERVIEW_STEP_ORDER)[number];

export interface InterviewQuestionMeta {
  step: InterviewStepId;
  prompt: string;
  /** `hint` renders dimmed next to a choice (real @clack/prompts `select()` support, confirmed
   * against its own type defs) — used to explain a real tradeoff inline rather than a separate
   * paragraph the person has to read before picking. */
  choices?: { value: string; label: string; hint?: string }[];
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
  memory: {
    step: "memory",
    prompt: "Where should retrieved knowledge (anything you ingest) live?",
    choices: [
      { value: "local", label: "Local (SQLite/LibSQL)", hint: "Free, no account, works offline. Simple keyword/BM25 matching." },
      { value: "cognee", label: "Cognee", hint: "Self-hosted or cloud. Builds a knowledge graph of entities/relationships and keeps correcting itself over time — needs a running Cognee instance (see COGNEE_SETUP.md)." },
    ],
  },
  productivity: {
    step: "productivity",
    prompt: "Add a productivity agent (reads your Gmail/Calendar once you connect Google, answers any question about them in plain language)?",
    choices: [
      { value: "no", label: "No" },
      { value: "yes", label: "Yes" },
    ],
  },
};

/** Pure per-step data for a thin prompts layer to render — never does any I/O itself. */
export function questionFor(step: InterviewStepId): InterviewQuestionMeta {
  return QUESTIONS[step];
}

/** The first step in canonical order whose answer isn't filled yet, or `null` once every step is
 * answered (the interview is done). */
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
  memory: MemoryBackendAnswer;
  productivity: ProductivityAnswer;
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
    case "memory": {
      const backend = (value as MemoryBackendAnswer | undefined)?.backend;
      return backend === "local" || backend === "cognee" ? [] : ["memory: a backend (local or cognee) is required."];
    }
    case "productivity":
      return value && "enabled" in (value as ProductivityAnswer) ? [] : ["productivity: an enabled flag is required."];
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
 * Applies one answer for `step`. Invalid values are rejected with a clear error and `answers` is
 * returned unchanged — this function never produces a partially-invalid state. With `model` the
 * only step (`InterviewStepId` has exactly one value), there's no "answered out of order" case
 * left to reject — that check existed when a second step (the removed "tools" one) could be
 * answered before the first; removed rather than left as an unreachable branch.
 */
export function applyAnswer(answers: InterviewAnswers, step: InterviewStepId, value: InterviewAnswers[InterviewStepId]): ApplyAnswerOk | ApplyAnswerError {
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
  memory: { backend: "local" },
  productivity: { enabled: false },
};

/** Applies `step`'s default answer (see `DEFAULT_ANSWERS`) — the pure implementation of "skip". */
export function skipStep(answers: InterviewAnswers, step: InterviewStepId): ApplyAnswerOk | ApplyAnswerError {
  return applyAnswer(answers, step, DEFAULT_ANSWERS[step]);
}
