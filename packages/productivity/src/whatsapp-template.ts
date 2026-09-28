/**
 * The one Meta-approved WhatsApp Message Template every proactive task action needs, so a scheduled
 * message can still be delivered outside the 24h customer-initiated session window — a real WhatsApp
 * platform rule (not a bug), found by actually hand-testing Phase 3 against a real
 * `@wappy_ai/whatsapp` channel: a "remind me" task's delivery came back `status: "queued"` with
 * `reason: "24h session window is closed and no fallback template is configured"`, since every
 * template here is agent-initiated by definition. See WHATSAPP_SETUP.md's "Scheduled messages"
 * section (added once this wiring lands in `create-agent`, Phase 5) for how to actually get this
 * approved by Meta.
 *
 * One generic template covers all 5 task templates — whatever text an action produces becomes this
 * template's one body variable, so there's no need to get 5 separate templates approved.
 *
 * Kept as plain data here, not a `@wappy_ai/whatsapp` `TemplateDef` import — this package depends
 * only on `@wappy_ai/core` (enforced by `packages/e2e/src/arch.ts`). `create-agent`'s generated
 * `index.ts`, which legitimately depends on both packages, is what actually constructs a real
 * `TemplateRegistry` from these field values (Phase 5) — this constant exists so that wiring and
 * `WHATSAPP_SETUP.md`'s instructions share one source of truth instead of two hand-typed copies of
 * the same template name.
 */
export const SCHEDULED_MESSAGE_TEMPLATE = {
  name: "wappy_scheduled_update",
  language: "en_US",
  category: "utility",
  /** The exact body text to submit to Meta for approval. One static sentence of context plus the
   * one dynamic variable — an all-variable body is more likely to be rejected by Meta's review as
   * vague/spammy than one that gives a reviewer (and the recipient) real context. */
  bodyTemplateText: "📋 Update from your Wappy agent:\n\n{{1}}",
  /** Matches the one entry `TemplateDef.variables` needs, and the key `templateVariables()` returns. */
  bodyVariableName: "update",
} as const;
