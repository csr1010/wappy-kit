import type { InboundMedia, InboundMessage } from "@wappy/core";

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

/**
 * Parses one raw Meta "messages" webhook payload (arbitrary/possibly-malformed JSON) into the
 * InboundMessages + StatusEvents it contains. Every field access is guarded — this NEVER throws,
 * no matter how garbled `payload` is (§6.2 "non-message payloads must not crash the process").
 */
export function parseWebhookPayload(payload: unknown, channel = "whatsapp"): ParsedWebhook {
  const messages: InboundMessage[] = [];
  const statuses: StatusEvent[] = [];

  const entries = Array.isArray(record(payload).entry) ? (record(payload).entry as unknown[]) : [];
  for (const entry of entries) {
    const changes = Array.isArray(record(entry).changes) ? (record(entry).changes as unknown[]) : [];
    for (const change of changes) {
      const c = record(change);
      if (c.field !== "messages") continue;
      const value = record(c.value);

      const rawMessages = Array.isArray(value.messages) ? (value.messages as unknown[]) : [];
      for (const raw of rawMessages) {
        const msg = parseOneMessage(raw, channel);
        if (msg) messages.push(msg);
      }

      const rawStatuses = Array.isArray(value.statuses) ? (value.statuses as unknown[]) : [];
      for (const raw of rawStatuses) {
        const s = parseOneStatus(raw);
        if (s) statuses.push(s);
      }
    }
  }
  return { messages, statuses };
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
    const title = str(record(interactive.button_reply).title) ?? str(record(interactive.list_reply).title);
    return { ...base, text: title };
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
    return { ...base, media: { kind: "location", caption: str(loc.name) } };
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
