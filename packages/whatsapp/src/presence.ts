/**
 * Typing indicator + mark-as-read (§6.1's "presence" message type) — listed in the spec and
 * checked off in M4's task list, but never actually built (found by hand-testing a real WhatsApp
 * conversation, T9.7). One combined Cloud API call does both: marking a message read AND showing
 * "typing..." until either the real reply is sent or 25 seconds pass, whichever comes first
 * (Meta's own documented behavior — never held open manually).
 *
 * Verified against Meta's current docs (2026-09-21, not from training-data memory):
 * https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/mark-message-as-read/
 */
export interface MarkReadAndTypingOptions {
  graphApiBaseUrl: string;
  phoneNumberId: string;
  accessToken: string;
  /** The inbound message's own id (from InboundMessage.id) — required by Meta's API; also what
   * ties the "typing..." indicator to the right conversation. */
  messageId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type MarkReadAndTypingResult = { ok: true } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export async function markReadAndTyping(opts: MarkReadAndTypingOptions): Promise<MarkReadAndTypingResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${opts.graphApiBaseUrl}/${opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.accessToken}` },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: opts.messageId, typing_indicator: { type: "text" } }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text().catch(() => "")}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}
