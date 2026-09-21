import type { Clock, DeliveryResult, SmartMessage } from "@wappy/core";
import { applyConstraints } from "./constraints.js";
import { renderNumberedFallback, type FallbackOptionsStore } from "./fallback.js";
import { renderSmartMessage, type CloudApiOutboundPayload } from "./render.js";
import { renderTemplate, type TemplateRegistry } from "./templates.js";
import { decideSendPath } from "./window-decision.js";
import { sendWithRetry, type HttpSendDeps } from "./http-send.js";
import type { OutboundQueue } from "./queue.js";
import type { SessionWindowTracker } from "../session-window.js";

export interface SendDeps extends Omit<HttpSendDeps, "clock"> {
  clock: Clock;
  sessionWindow: SessionWindowTracker;
  fallbackStore?: FallbackOptionsStore;
  templateRegistry?: TemplateRegistry;
  defaultTemplateName?: string;
  templateVariables?: (message: SmartMessage) => Record<string, string>;
  queue?: OutboundQueue;
  /** Required to use `queue` — identifies this logical send across a crash/restart. */
  idempotencyKey?: string;
}

/**
 * The real "smart send": window guard -> template-or-queue when closed -> constrain/truncate ->
 * render richest type -> send with retry -> on failure, degrade rich messages to numbered plain
 * text and try once more (§6.1-6.3). Replaces M3's placeholder text-only channel.send().
 */
export async function sendSmartMessage(message: SmartMessage, to: string, deps: SendDeps): Promise<DeliveryResult> {
  const now = deps.clock.now();
  const { message: constrained } = applyConstraints(message);
  const windowOpen = deps.sessionWindow.windowOpen(to, now);
  const decision = decideSendPath({ windowOpen, defaultTemplateName: deps.defaultTemplateName });

  if (decision.kind === "queued") return { status: "queued", reason: decision.reason };

  let payload: CloudApiOutboundPayload;
  if (decision.kind === "template") {
    if (!deps.templateRegistry) return { status: "queued", reason: "window closed and no template registry configured" };
    const rendered = renderTemplate(deps.templateRegistry, to, decision.templateName, deps.templateVariables?.(constrained) ?? {});
    if (!rendered.ok) return { status: "queued", reason: rendered.error };
    payload = rendered.payload;
  } else {
    payload = renderSmartMessage(constrained, to);
  }

  const primary = await attemptAndReport(payload, to, deps);
  if (primary.status === "sent" || decision.kind === "template") return primary; // no further fallback ladder past a template attempt

  const hasRichOptions = decision.kind === "freeform" && Boolean(constrained.buttons ?? constrained.list);
  if (!hasRichOptions) return primary;

  const numbered = renderNumberedFallback(constrained);
  deps.fallbackStore?.record(to, numbered.options, now);
  const fallbackResult = await attemptAndReport(renderSmartMessage({ text: numbered.text }, to), to, deps, deps.idempotencyKey ? `${deps.idempotencyKey}:fallback` : undefined);
  if (fallbackResult.status === "sent") return { status: "fellBack", messageId: fallbackResult.messageId, reason: primary.reason };
  return { status: "failed", reason: fallbackResult.reason ?? primary.reason };
}

async function attemptAndReport(payload: CloudApiOutboundPayload, to: string, deps: SendDeps, idempotencyKeyOverride?: string): Promise<DeliveryResult> {
  const idempotencyKey = idempotencyKeyOverride ?? deps.idempotencyKey;
  if (!deps.queue || !idempotencyKey) {
    const result = await sendWithRetry(payload, deps);
    return result.ok ? { status: "sent", messageId: result.messageId } : { status: "failed", reason: result.reason };
  }

  const existing = deps.queue.enqueue({ idempotencyKey, to, payload }, deps.clock.now());
  if (existing.status === "sent") return { status: "sent", messageId: existing.metaMessageId }; // crash-safe: already delivered before, never resend

  deps.queue.update(idempotencyKey, { status: "pending", attempts: existing.attempts + 1 }, deps.clock.now());
  const result = await sendWithRetry(payload, deps);
  if (result.ok) {
    deps.queue.update(idempotencyKey, { status: "sent", metaMessageId: result.messageId }, deps.clock.now());
    return { status: "sent", messageId: result.messageId };
  }
  deps.queue.update(idempotencyKey, { status: "failed", lastError: result.reason }, deps.clock.now());
  return { status: "failed", reason: result.reason };
}
