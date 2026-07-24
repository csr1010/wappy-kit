import type { CloudApiOutboundPayload } from "./render.js";

/** Mark an inbound message read (and optionally show a typing bubble) — scoped to the message id, no `to`. */
export function renderMarkAsRead(messageId: string, opts: { typingIndicator?: boolean } = {}): CloudApiOutboundPayload {
  const body: CloudApiOutboundPayload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  if (opts.typingIndicator) body.typing_indicator = { type: "text" };
  return body;
}
