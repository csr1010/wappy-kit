import type { InboundMessage, MessageChannel } from "@wappy_ai/core";
import type { WhatsAppMessageChannel } from "./channel.js";

export interface DispatchInboundOptions {
  channel: MessageChannel;
  /** Raw, signature-verified webhook payload. */
  payload: unknown;
  /** What to do with each fresh message — usually `agent.handle`, or a host's own routing that
   * picks an agent per message (e.g. a multi-tenant host). */
  handle: (message: InboundMessage) => Promise<unknown>;
  onError?: (e: unknown) => void;
}

/**
 * The receive → "read + typing…" → handle loop every WhatsApp host needs, shared by
 * `createWebhookServer` and hosts that bring their own HTTP server (Hono, Express, a multi-number
 * cloud). `channel.receive()` drops Meta's retries and opens the 24h window; the read receipt +
 * typing indicator goes out before the handler runs, not awaited, because it's the user-visible
 * "…" while slower model/tool work runs (Meta dismisses it after 25s or when the reply lands).
 * Resolves when every handler has settled; never rejects. Returns the fresh messages.
 */
export async function dispatchInbound(opts: DispatchInboundOptions): Promise<InboundMessage[]> {
  let messages: InboundMessage[];
  try {
    messages = await opts.channel.receive(opts.payload);
  } catch (e) {
    opts.onError?.(e);
    return [];
  }
  const typing = (opts.channel as Partial<WhatsAppMessageChannel>).markReadAndTyping;
  await Promise.all(
    messages.map((message) => {
      // A channel without it (not WhatsApp) just skips this.
      if (typeof typing === "function") {
        void typing.call(opts.channel, message.id).then(
          (r) => { if (!r.ok) opts.onError?.(new Error(`markReadAndTyping: ${r.error}`)); },
          (e: unknown) => opts.onError?.(e),
        );
      }
      return opts.handle(message).catch((e: unknown) => opts.onError?.(e));
    }),
  );
  return messages;
}
