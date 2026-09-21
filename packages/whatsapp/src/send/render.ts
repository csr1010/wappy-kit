import type { SmartMessage } from "@wappy/core";

/** The JSON body posted to POST /{phone_number_id}/messages. */
export type CloudApiOutboundPayload = Record<string, unknown>;

function context(message: SmartMessage): Record<string, unknown> {
  return message.quoteId ? { context: { message_id: message.quoteId } } : {};
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
        body: { text: message.text ?? "" },
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
        body: { text: message.text ?? "" },
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
        body: { text: message.text ?? "" },
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
