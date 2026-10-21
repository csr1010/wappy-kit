import type { InboundMedia, InboundMessage } from "@wappy_ai/core";

export type WhatsAppStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusEvent {
  messageId: string;
  status: WhatsAppStatus;
  timestamp: number;
  recipientId: string;
  error?: { code: number; message: string };
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusEvent[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}
function record(x: unknown): Record<string, unknown> {
  return isRecord(x) ? x : {};
}
function tsMs(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n * 1000 : Date.now();
}

const MEDIA_TYPES = ["image", "document", "video", "audio"] as const;

/** One business phone number's share of a webhook delivery. */
export interface NumberBatch extends ParsedWebhook {
  /** Meta phone_number_id the messages arrived on (or the statuses were sent from). */
  phoneNumberId: string;
  displayPhoneNumber?: string;
}

/**
 * Parses one raw Meta "messages" webhook payload (arbitrary/possibly-malformed JSON) into the
 * InboundMessages + StatusEvents it contains. Every field access is guarded — this NEVER throws,
 * no matter how garbled `payload` is (§6.2 "non-message payloads must not crash the process").
 */
export function parseWebhookPayload(payload: unknown, channel = "whatsapp"): ParsedWebhook {
  const messages: InboundMessage[] = [];
  const statuses: StatusEvent[] = [];
  for (const b of parseWebhookByNumber(payload, channel, { keepUnaddressed: true })) {
    messages.push(...b.messages);
    statuses.push(...b.statuses);
  }
  return { messages, statuses };
}

/**
 * Same parse, grouped by the business number each change was addressed to
 * (`value.metadata.phone_number_id`). A host serving many numbers from one webhook needs this to
 * pick the right tenant and send-from number; the flat `parseWebhookPayload` loses it. Changes
 * with no phone_number_id are dropped (nothing to route them to), and batches for the same number
 * are merged, in payload order. Never throws.
 */
export function parseWebhookByNumber(payload: unknown, channel = "whatsapp", opts: { keepUnaddressed?: boolean } = {}): NumberBatch[] {
  const byNumber = new Map<string, NumberBatch>();

  const entries = Array.isArray(record(payload).entry) ? (record(payload).entry as unknown[]) : [];
  for (const entry of entries) {
    const changes = Array.isArray(record(entry).changes) ? (record(entry).changes as unknown[]) : [];
    for (const change of changes) {
      const c = record(change);
      if (c.field !== "messages") continue;
      const value = record(c.value);
      const meta = record(value.metadata);
      const phoneNumberId = str(meta.phone_number_id) ?? "";
      if (!phoneNumberId && !opts.keepUnaddressed) continue;

      let batch = byNumber.get(phoneNumberId);
      if (!batch) {
        batch = { phoneNumberId, displayPhoneNumber: str(meta.display_phone_number), messages: [], statuses: [] };
        byNumber.set(phoneNumberId, batch);
      }

      const rawMessages = Array.isArray(value.messages) ? (value.messages as unknown[]) : [];
      for (const raw of rawMessages) {
        const msg = parseOneMessage(raw, channel);
        if (msg) batch.messages.push(msg);
      }

      const rawStatuses = Array.isArray(value.statuses) ? (value.statuses as unknown[]) : [];
      for (const raw of rawStatuses) {
        const s = parseOneStatus(raw);
        if (s) batch.statuses.push(s);
      }
    }
  }
  return [...byNumber.values()];
}

function parseOneMessage(raw: unknown, channel: string): InboundMessage | null {
  const r = record(raw);
  const id = str(r.id);
  const contactId = str(r.from);
  if (!id || !contactId) return null; // can't build a valid InboundMessage without these

  const base = { id, contactId, channel, timestamp: tsMs(r.timestamp), raw };
  const type = str(r.type) ?? "unknown";

  if (type === "text") {
    return { ...base, text: str(record(r.text).body) };
  }

  if (type === "interactive") {
    const interactive = record(r.interactive);
    const buttonReply = record(interactive.button_reply);
    const listReply = record(interactive.list_reply);
    const title = str(buttonReply.title) ?? str(listReply.title);
    if (title !== undefined) {
      return { ...base, text: title, selectionId: str(buttonReply.id) ?? str(listReply.id) };
    }
    // Not a recognized interactive subtype (e.g. a Flow "nfm_reply") — flag as unsupported rather
    // than silently returning a content-less message.
    const subtype = str(interactive.type) ?? "unknown";
    return { ...base, text: `[unsupported WhatsApp message type: interactive/${subtype}]` };
  }

  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const m = record(r[type]);
    const isVoiceNote = type === "audio" && m.voice === true;
    const media: InboundMedia = {
      kind: isVoiceNote ? "voice" : (type as "image" | "document" | "video" | "audio"),
      // Cloud API gives a media *id*, not a URL — resolve via downloadWhatsAppMedia() (T3.7).
      url: str(m.id),
      mimeType: str(m.mime_type),
      caption: str(m.caption),
    };
    return { ...base, media };
  }

  if (type === "location") {
    const loc = record(r.location);
    const latitude = typeof loc.latitude === "number" ? loc.latitude : undefined;
    const longitude = typeof loc.longitude === "number" ? loc.longitude : undefined;
    return { ...base, media: { kind: "location", caption: str(loc.name), latitude, longitude } };
  }

  if (type === "reaction") {
    return { ...base, text: str(record(r.reaction).emoji) };
  }

  return { ...base, text: `[unsupported WhatsApp message type: ${type}]` };
}

function isKnownStatus(s: unknown): s is WhatsAppStatus {
  return s === "sent" || s === "delivered" || s === "read" || s === "failed";
}

function parseOneStatus(raw: unknown): StatusEvent | null {
  const r = record(raw);
  const messageId = str(r.id);
  const recipientId = str(r.recipient_id);
  if (!messageId || !recipientId || !isKnownStatus(r.status)) return null;

  const errors = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];
  const firstError = record(errors[0]);
  const error = typeof firstError.code === "number" ? { code: firstError.code, message: str(firstError.title) ?? "error" } : undefined;

  return { messageId, status: r.status, timestamp: tsMs(r.timestamp), recipientId, error };
}
