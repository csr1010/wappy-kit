import type { Model, Skill } from "@wappy/core";

/**
 * Store-specific skill generation (M9 scope addition, 2026-09-21 — see SPEC.md §4.1 step 3 Decisions
 * Log entry): a setup-time-only LLM call that drafts a tailored `promptFragment` from real facts
 * about the merchant's own store, instead of shipping only the generic reference skills verbatim.
 * Deliberately narrow, per the session decision that picked this over the two riskier alternatives
 * (LLM-synthesized RAG content, LLM-generated NEW tools from a full API schema): the generated skill
 * still only REFERENCES the caller's already-fixed, already-reviewed tool set (`toolNames`) — it
 * never invents a capability, and it runs once at install time, never on the runtime hot path. Kept
 * connector-agnostic (plain string `storeContext`, no Shopify types) so this stays usable from any
 * `create-wappy` tools step, not just Shopify — hub-and-spoke: this package never imports
 * `@wappy/tools-openapi`.
 */

/** Caps how much store context reaches the prompt — matches this codebase's established "bound
 * every model-adjacent value" convention (T6.6's `boundToolResult`, `bound-inbound-text.ts`'s
 * 4,000-char default) rather than trusting a caller to have already sized its input sensibly. */
export const DEFAULT_MAX_STORE_CONTEXT_CHARS = 4_000;

const DEFAULT_SKILL_NAME = "store-info";
const DEFAULT_SKILL_DESCRIPTION = "Answers questions about this store using tailored, store-specific guidance generated at setup time.";

const SYSTEM_PROMPT =
  "You are drafting a short system-prompt instruction (a 'skill') for a WhatsApp customer-support agent for ONE specific store. " +
  "Write 2-4 sentences, in second person ('You can...'), describing what the agent can help with based ONLY on the store facts given. " +
  "Do not invent products, policies, or capabilities beyond what the facts state or the listed tools imply. " +
  "Do not mention that you are an AI or that this text was generated. Output plain text only, no headings or markdown.";

export interface GenerateStoreSkillOptions {
  model: Model;
  /** Plain-text facts about the store (e.g. ingested policy text, a short catalog summary) — the
   * caller gathers this however its own connector works; this function has no opinion on the
   * source. Truncated to `maxStoreContextChars` before it ever reaches the prompt. */
  storeContext: string;
  /** Tool names the generated skill may reference — should be exactly the names actually
   * registered (e.g. the Shopify connector's own tool names), so the generated promptFragment
   * never implies a capability the agent doesn't really have. */
  toolNames?: string[];
  /** Override the generated `Skill`'s name/description; the promptFragment is always the
   * model-drafted text. Defaults describe a generic store-info skill. */
  name?: string;
  description?: string;
  maxStoreContextChars?: number;
}

/**
 * Drafts one `Skill` from real store facts via a single model call. Returns a rejected promise if
 * the store context is empty/whitespace-only (nothing to ground a draft in) or if the model returns
 * no usable text — callers (the `create-wappy` interview, in practice) should catch either case and
 * fall back to a static reference skill (e.g. `STORE_INFO_SKILL`) rather than propagate a hard setup
 * failure over what's meant to be a nice-to-have personalization step.
 */
export async function generateStoreSkill(opts: GenerateStoreSkillOptions): Promise<Skill> {
  const trimmedContext = opts.storeContext.trim();
  if (trimmedContext.length === 0) {
    throw new Error("generateStoreSkill: storeContext is empty — nothing to generate a store-specific skill from.");
  }
  const maxChars = opts.maxStoreContextChars ?? DEFAULT_MAX_STORE_CONTEXT_CHARS;
  const boundedContext = trimmedContext.length > maxChars ? trimmedContext.slice(0, maxChars) : trimmedContext;
  const toolNames = opts.toolNames ?? [];

  const prompt = [
    `Store facts:\n${boundedContext}`,
    toolNames.length > 0 ? `Tools the agent can actually call: ${toolNames.join(", ")}` : "Tools the agent can actually call: (none)",
  ].join("\n\n");

  const result = await opts.model.generate({ system: SYSTEM_PROMPT, prompt });
  const text = result.text?.trim();
  if (!text) {
    throw new Error("generateStoreSkill: the model returned no text to use as a promptFragment.");
  }

  return {
    name: opts.name ?? DEFAULT_SKILL_NAME,
    description: opts.description ?? DEFAULT_SKILL_DESCRIPTION,
    promptFragment: text,
    tools: toolNames.length > 0 ? toolNames : undefined,
  };
}
