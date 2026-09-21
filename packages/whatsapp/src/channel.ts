import { systemClock, type Clock, type DeliveryResult, type InboundMessage, type MessageChannel, type SmartMessage } from "@wappy/core";
import { parseWebhookPayload, type StatusEvent } from "./parser.js";
import { createMemorySeenStore, type SeenStore } from "./seen-store.js";
import { createSessionWindowTracker, type SessionWindowTracker } from "./session-window.js";
import { sendSmartMessage, type SendDeps } from "./send/orchestrator.js";
import type { FallbackOptionsStore } from "./send/fallback.js";
import type { TemplateRegistry } from "./send/templates.js";
import type { OutboundQueue } from "./send/queue.js";
import type { BackoffOptions } from "./send/backoff.js";

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
   * InboundMessage[] return type, so they're routed here instead. Also drives the delivery-state
   * machine when wired to updateDeliveryState (M4, send/delivery-state.ts) by the caller.
   */
  onStatus?: (status: StatusEvent) => void;

  // --- smart send (M4) ---
  /** Full Clock (now + sleep) for retry backoff; falls back to `now` + real timers, then systemClock. */
  clock?: Clock;
  fallbackStore?: FallbackOptionsStore;
  templateRegistry?: TemplateRegistry;
  defaultTemplateName?: string;
  templateVariables?: (message: SmartMessage) => Record<string, string>;
  queue?: OutboundQueue;
  /** Derives the outbound-queue idempotency key for a send; required together with `queue`. */
  idempotencyKeyFor?: (to: string, message: SmartMessage) => string;
  maxSendAttempts?: number;
  backoff?: BackoffOptions;
}

export function createWhatsAppChannel(opts: WhatsAppChannelOptions): MessageChannel {
  const base = opts.graphApiBaseUrl ?? "https://graph.facebook.com/v21.0";
  const fetchFn = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const clock: Clock = opts.clock ?? { ...systemClock, now };
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
        // checkAndSet claims the slot atomically FIRST (so two concurrent deliveries of the same
        // retry can't both slip through to onStatus), then forget() releases it if onStatus fails,
        // so a genuine later retry can still reprocess it instead of it being lost forever.
        if (!(await seenStore.checkAndSet(key, now()))) continue;
        try {
          await opts.onStatus?.(status);
        } catch (e) {
          await seenStore.forget(key);
          throw e;
        }
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
      const deps: SendDeps = {
        graphApiBaseUrl: base,
        phoneNumberId: opts.phoneNumberId,
        accessToken: opts.accessToken,
        fetchImpl: fetchFn,
        clock,
        maxAttempts: opts.maxSendAttempts,
        backoff: opts.backoff,
        sessionWindow,
        fallbackStore: opts.fallbackStore,
        templateRegistry: opts.templateRegistry,
        defaultTemplateName: opts.defaultTemplateName,
        templateVariables: opts.templateVariables,
        queue: opts.queue,
        idempotencyKey: opts.idempotencyKeyFor?.(to, message),
      };
      return sendSmartMessage(message, to, deps);
    },
  };
}
