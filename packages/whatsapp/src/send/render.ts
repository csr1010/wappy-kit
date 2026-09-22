import type { SmartMessage } from "@wappy/core";

/** The JSON body posted to POST /{phone_number_id}/messages. */
export type CloudApiOutboundPayload = Record<string, unknown>;

function context(message: SmartMessage): Record<string, unknown> {
  return message.quoteId ? { context: { message_id: message.quoteId } } : {};
}

/** Meta HARD-rejects an interactive message with an empty `body.text` — confirmed against the real
 * Cloud API (400: "The parameter interactive.body.text is required."), not assumed. A model
 * emitting `list`/`buttons`/`cta` without its own intro `text` (common — it's easy to put
 * everything into the rows/buttons and forget the intro sentence) used to send `text: ""`,
 * causing every such send to fail and silently degrade to the numbered-text fallback ladder —
 * found by hand-testing a real product list. These are the fallback ONLY when the model didn't
 * supply real intro text; a skill/prompt writing its own text still wins (§6.3: model controls UX intent). */
function bodyText(message: SmartMessage, fallback: string): string {
  return message.text && message.text.length > 0 ? message.text : fallback;
}

/** Renders `SmartMessage.header` into the Cloud API's `interactive.header` shape (§6.1/M12) —
 * only ever called when `message.header` is set, which the core schema already guarantees means
 * buttons/list/cta is also present (Meta's own constraint: header is meaningless standalone). */
function headerPayload(header: NonNullable<SmartMessage["header"]>): Record<string, unknown> {
  switch (header.type) {
    case "text":
      return { type: "text", text: header.text };
    case "image":
      return { type: "image", image: { link: header.url } };
    case "video":
      return { type: "video", video: { link: header.url } };
    case "document":
      return { type: "document", document: { link: header.url, ...(header.filename ? { filename: header.filename } : {}) } };
  }
}

/**
 * Renders an already-constraint-checked SmartMessage into a Cloud API payload. Picks the richest
 * type the message actually asks for: buttons > list > cta > media > plain text (§6.1). Text
 * formatting (bold/italic/strikethrough/mono) is WhatsApp's own markdown-like syntax — the model
 * emits it directly in `text`, so this never rewrites/escapes it.
 */
export function renderSmartMessage(message: SmartMessage, to: string): CloudApiOutboundPayload {
  const base = { messaging_product: "whatsapp", to, ...context(message) };

  if (message.buttons) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        ...(message.header ? { header: headerPayload(message.header) } : {}),
        body: { text: bodyText(message, "Please choose an option:") },
        action: { buttons: message.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    };
  }

  if (message.list) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "list",
        ...(message.header ? { header: headerPayload(message.header) } : {}),
        body: { text: bodyText(message, "Here's what I found:") },
        action: {
          button: message.list.buttonText,
          sections: message.list.sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
          })),
        },
      },
    };
  }

  if (message.cta) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "cta_url",
        ...(message.header ? { header: headerPayload(message.header) } : {}),
        body: { text: bodyText(message, "Here's a link that might help:") },
        action: { name: "cta_url", parameters: { display_text: message.cta.text, url: message.cta.url } },
      },
    };
  }

  if (message.media) {
    const { kind, url, caption, filename } = message.media;
    // Cloud API has no distinct outbound "voice" type; a voice note is an audio message flagged elsewhere at send time.
    const apiType = kind === "voice" ? "audio" : kind;
    const body: Record<string, unknown> = { link: url };
    if (caption && apiType !== "audio") body.caption = caption; // Cloud API rejects captions on audio
    if (filename && apiType === "document") body.filename = filename;
    return { ...base, type: apiType, [apiType]: body };
  }

  return { ...base, type: "text", text: { body: message.text ?? "", preview_url: true } };
}

/** A standalone emoji reaction to a prior inbound message — not LLM-authored content, so it's not part of SmartMessage. */
export function renderReaction(to: string, messageId: string, emoji: string): CloudApiOutboundPayload {
  return { messaging_product: "whatsapp", to, type: "reaction", reaction: { message_id: messageId, emoji } };
}
