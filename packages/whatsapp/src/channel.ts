import type { DeliveryResult, InboundMessage, MessageChannel, SmartMessage } from "@wappy/core";
import { parseWebhookPayload, type StatusEvent } from "./parser.js";
import { createMemorySeenStore, type SeenStore } from "./seen-store.js";
import { createSessionWindowTracker, type SessionWindowTracker } from "./session-window.js";

export interface WhatsAppChannelOptions {
  /** Meta phone_number_id to send from. */
  phoneNumberId: string;
  accessToken: string;
  graphApiBaseUrl?: string;
  channelName?: string;
  seenStore?: SeenStore;
  sessionWindow?: SessionWindowTracker;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * Status webhooks (sent/delivered/read/failed) have no slot in MessageChannel.receive()'s
   * InboundMessage[] return type, so they're routed here instead (M4 wires retry/fallback to it).
   */
  onStatus?: (status: StatusEvent) => void;
}

/**
 * Rendering is intentionally minimal here (text only) — SmartMessage's rich types (buttons/list/
 * cta/media) + capability-aware fallback are M4's job. M3 only needs a real, conformant send().
 */
export function createWhatsAppChannel(opts: WhatsAppChannelOptions): MessageChannel {
  const base = opts.graphApiBaseUrl ?? "https://graph.facebook.com/v21.0";
  const fetchFn = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const seenStore = opts.seenStore ?? createMemorySeenStore();
  const sessionWindow = opts.sessionWindow ?? createSessionWindowTracker();
  const channelName = opts.channelName ?? "whatsapp";

  return {
    name: channelName,

    async receive(rawWebhook: unknown): Promise<InboundMessage[]> {
      const { messages, statuses } = parseWebhookPayload(rawWebhook, channelName);

      for (const status of statuses) {
        // Keyed on (messageId, status), not messageId alone: a message legitimately passes through
        // several distinct statuses (sent -> delivered -> read), which must NOT be deduped against
        // each other — only a retried delivery of the SAME status transition should be dropped.
        const key = `status:${status.messageId}:${status.status}`;
        if (await seenStore.has(key, now())) continue; // already handled successfully before

        // Mark seen only AFTER onStatus succeeds: if it throws, this id stays unmarked, so Meta's
        // webhook retry (its standard behavior on a non-2xx response) genuinely retries the
        // handler instead of the status being silently dropped forever within the TTL.
        await opts.onStatus?.(status);
        await seenStore.checkAndSet(key, now());
      }

      const fresh: InboundMessage[] = [];
      for (const message of messages) {
        const isNew = await seenStore.checkAndSet(message.id, now());
        if (!isNew) continue; // Meta retried a delivery we already processed
        sessionWindow.recordInbound(message.contactId, now());
        fresh.push(message);
      }
      return fresh;
    },

    async send(to: string, message: SmartMessage): Promise<DeliveryResult> {
      const body = { messaging_product: "whatsapp", to, type: "text", text: { body: message.text ?? "" } };
      let res: Response;
      try {
        res = await fetchFn(`${base}/${opts.phoneNumberId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.accessToken}` },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { status: "failed", reason: `network error: ${(e as Error).message}` };
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        payload = undefined;
      }

      if (!res.ok) {
        const err = (payload as { error?: { code?: number; message?: string } } | undefined)?.error;
        return { status: "failed", reason: err ? `meta ${err.code}: ${err.message}` : `http ${res.status}` };
      }

      const messageId = (payload as { messages?: { id?: string }[] } | undefined)?.messages?.[0]?.id;
      return { status: "sent", messageId };
    },
  };
}
