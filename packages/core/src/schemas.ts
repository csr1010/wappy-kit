import { z } from "zod";

/**
 * Runtime schemas for the core data shapes (§3, §6.1, §6.3, §9 of SPEC.md).
 *
 * Layering rule for WhatsApp send-time limits (§6.1): this schema enforces
 * STRUCTURAL bounds only (button/row/section counts) because those can't be
 * fixed by truncation without changing meaning. TEXT LENGTH limits (button
 * title <=20, list row title <=24, row description <=72) are intentionally
 * NOT enforced here — @wappy/whatsapp (M4) truncates them at send time, so
 * an over-length string is valid input at this layer and a renderer concern
 * downstream. See docs/CONTRACTS.md.
 */

export const InboundMediaSchema = z.object({
  kind: z.enum(["image", "document", "video", "audio", "voice", "location"]),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  caption: z.string().optional(),
});
export type InboundMedia = z.infer<typeof InboundMediaSchema>;

export const InboundMessageSchema = z.object({
  /** Channel-native message id, used for idempotency/dedupe (§6.2). */
  id: z.string().min(1),
  /** Opaque contact identifier, stable per sender on this channel. */
  contactId: z.string().min(1),
  /** Which MessageChannel produced this, e.g. "whatsapp". */
  channel: z.string().min(1),
  text: z.string().optional(),
  media: InboundMediaSchema.optional(),
  /** Epoch milliseconds. */
  timestamp: z.number(),
  /** Channel-native payload, kept for debugging/replay; never parsed by core. */
  raw: z.unknown().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const SmartButtonSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});
export const SmartButtonsSchema = z.array(SmartButtonSchema).min(1).max(3);

export const SmartListRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export const SmartListSectionSchema = z.object({
  title: z.string().optional(),
  rows: z.array(SmartListRowSchema).min(1),
});
export const SmartListSchema = z
  .object({
    buttonText: z.string().min(1),
    sections: z.array(SmartListSectionSchema).min(1).max(10),
  })
  .refine((l) => l.sections.reduce((n, s) => n + s.rows.length, 0) <= 10, {
    message: "list: total rows across all sections must be <= 10",
  });

export const SmartCtaSchema = z.object({
  text: z.string().min(1),
  url: z.string().url(),
});

export const SmartMediaSchema = z.object({
  kind: z.enum(["image", "document", "video", "audio", "voice"]),
  url: z.string().min(1),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
});

export const SmartMessageSchema = z
  .object({
    text: z.string().min(1).optional(),
    buttons: SmartButtonsSchema.optional(),
    list: SmartListSchema.optional(),
    cta: SmartCtaSchema.optional(),
    media: SmartMediaSchema.optional(),
    /** id of an inbound message this reply quotes ("reply in context"). */
    quoteId: z.string().optional(),
    /** Reserved slot for WhatsApp Flows/forms (deferred; SPEC §6.1). Not validated in v0.1. */
    flow: z.unknown().optional(),
  })
  .refine((m) => Boolean(m.text ?? m.buttons ?? m.list ?? m.cta ?? m.media), {
    message: "SmartMessage: at least one of text/buttons/list/cta/media is required",
  });
export type SmartMessage = z.infer<typeof SmartMessageSchema>;

/** JSON Schema for SmartMessage — this is what the model is asked to emit (§6.3). */
export const smartMessageJsonSchema = z.toJSONSchema(SmartMessageSchema);

export const DeliveryStatusSchema = z.enum(["sent", "failed", "queued", "fellBack"]);
export const DeliveryResultSchema = z
  .object({
    status: DeliveryStatusSchema,
    messageId: z.string().optional(),
    /** Actionable, human-readable reason — never a raw stack trace (§10). */
    reason: z.string().optional(),
  })
  .refine((d) => (d.status === "failed" || d.status === "fellBack" ? Boolean(d.reason) : true), {
    message: "DeliveryResult: reason is required when status is failed or fellBack",
  });
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

export const TurnSchema = z.object({
  id: z.string().min(1),
  contactId: z.string().min(1),
  role: z.enum(["user", "agent", "system"]),
  text: z.string().optional(),
  timestamp: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const RouterDecisionSchema = z.object({
  intent: z.string().min(1),
  skill: z.string().optional(),
  needsRAG: z.boolean(),
  needsTool: z.boolean(),
  escalate: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

export const ToolResultSchema = z.object({
  toolName: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
