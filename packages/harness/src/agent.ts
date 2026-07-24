import type { Agent, Clock, DeliveryResult, InboundMessage, MessageChannel, Memory, Model, Router, RouterDecision, SmartMessage, TracedSystem, Tracer, Turn } from "@wappy/core";
import { boundInboundText, DEFAULT_INBOUND_TEXT_LIMITS, type InboundTextLimits } from "./bound-inbound-text.js";
import { composeSmartMessage } from "./compose.js";
import type { SkillRegistry } from "./skills.js";

const SCOPE_GUARDRAIL = "If the user's request is genuinely unrelated to what you're configured to help with, say so honestly and directly rather than guessing or making something up.";

const REFUSAL_TEXT = "That message is too long for me to process — could you send it as a shorter message?";
const OVERSIZED_PLACEHOLDER = "(the user sent a message too large to process)";

/** TracedSystem values a MessageChannel is allowed to be traced under — deliberately closed (not
 * `channel.name` verbatim) so a customized channel name can't inject an out-of-union label into
 * `tracer.touched()`/`events()`. */
const KNOWN_TRACED_CHANNELS: ReadonlySet<string> = new Set<TracedSystem>(["whatsapp"]);

export interface AgentDeps {
  channel: MessageChannel;
  memory: Memory;
  router: Router;
  model: Model;
  clock: Clock;
  tracer: Tracer;
  skills?: SkillRegistry;
  /** RAG hook — default: no-op (no extra context). Real semantic search lands in M7/M8 (§9 Scenario B is a stub here). */
  retrieveRag?: (input: { contactId: string; query: string }) => Promise<string[]>;
  /** Tool-invocation hook — default: no-op (no findings). Real tool execution lands in M7 tools-openapi (§9 Scenario C is a stub here). */
  invokeTools?: (input: { message: InboundMessage; decision: RouterDecision }) => Promise<string[]>;
  /** Below this, skill/RAG/tool augmentation is suppressed but a reply is still always sent (§9 confidence gate). Default 0.3. */
  confidenceThreshold?: number;
  onEscalate?: (message: InboundMessage, decision: RouterDecision) => void | Promise<void>;
  /** Id for the agent's own reply Turn to a given inbound message — MUST be deterministic per
   * `message.id` (and unique across contacts), since it's also the idempotency marker a replay is
   * checked against. Default: `${message.id}:reply`. */
  idGenerator?: (message: InboundMessage) => string;
  /** Thresholds for an oversized inbound message.text (§10) — truncated with a notice below
   * `refuseChars`, politely declined (no routing/compose, still exactly one reply) above it. */
  inboundTextLimits?: InboundTextLimits;
}

/**
 * Orchestrates one inbound message -> reply: load memory -> route -> (skill/RAG/tool) -> compose ->
 * confidence gate -> send -> persist -> trace, each step degrading rather than crashing (§9, §10).
 * Per-contact serialized so two rapid messages for the same contact never interleave or double-persist.
 */
export function createAgent(deps: AgentDeps): Agent {
  const chains = new Map<string, Promise<unknown>>();
  // handleOne is exception-safe by construction (every fallible step below has its own fallback,
  // plus an outer safety net), so prev's fulfill/reject handlers are identical either way.
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const settle = prev.then(fn, fn);
    chains.set(key, settle);
    // Free this contact's slot once idle (no newer call queued behind this one), so a long-running
    // process serving many distinct contacts over time doesn't leak one Map entry per contact forever.
    // settle can never reject (handleSafely converts every throw into a resolved DeliveryResult), so
    // only the fulfillment arm is reachable — a symmetric reject arm would be permanently dead code.
    void settle.then(() => { if (chains.get(key) === settle) chains.delete(key); });
    return settle;
  };

  return {
    handle: (message) => serialize(message.contactId, () => handleSafely(message, deps)),
  };
}

async function handleSafely(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  try {
    return await handleOne(message, deps);
  } catch (e) {
    // Absolute last resort: some dependency (tracer, skill registry, clock, idGenerator, ...) threw
    // somewhere not already given a typed fallback above. Still answer honestly rather than reject.
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function safeLoad(memory: Memory, contactId: string): Promise<Turn[]> {
  try {
    return await memory.load(contactId);
  } catch {
    return []; // degrade to a "new contact" view rather than blocking the whole turn on a memory outage
  }
}

async function safeAppend(memory: Memory, turn: Turn): Promise<void> {
  try {
    await memory.append(turn);
  } catch {
    // best-effort: a persistence hiccup must not cost the user their reply
  }
}

/** Runs an optional hook (RAG/tools/escalate), swallowing a throw so one integration's outage
 * degrades to "no extra context" rather than losing the whole turn (§10, "each step with a fallback"). */
async function safeCall<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * A textual stand-in for what was persisted to memory: `SmartMessage.text` is independent of
 * `buttons`/`list`/`cta`/`media` (§6.3 "the model controls UX intent — buttons vs list vs text"), so
 * a rich reply with no `text` set would otherwise persist as `Turn.text: undefined` — which
 * model.ts's `toModelMessages()` then filters out entirely, making the agent's own reply invisible
 * to itself on the next turn. Never returns undefined for a message that satisfies SmartMessageSchema
 * (at least one field is always present).
 */
function summarizeReply(message: SmartMessage): string | undefined {
  if (message.text) return message.text;
  const parts: string[] = [];
  if (message.buttons) parts.push(`buttons: ${message.buttons.map((b) => b.title).join(", ")}`);
  if (message.list) parts.push(`list: ${message.list.sections.flatMap((s) => s.rows.map((r) => r.title)).join(", ")}`);
  if (message.cta) parts.push(`link "${message.cta.text}": ${message.cta.url}`);
  if (message.media) parts.push(message.media.caption ? `${message.media.kind}: ${message.media.caption}` : message.media.kind);
  return parts.length > 0 ? `[${parts.join("; ")}]` : undefined;
}

function trace(tracer: Tracer, system: TracedSystem, event: string, data?: unknown): void {
  try {
    tracer.record(system, event, data);
  } catch {
    // observability must never cost the user their reply
  }
}

async function handleOne(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  trace(deps.tracer, "memory", "load", { contactId: message.contactId });
  const history = await safeLoad(deps.memory, message.contactId);

  // The idempotency marker is the REPLY turn, not the inbound one: the inbound turn is persisted
  // unconditionally below, long before the message is actually answered, so checking for it would
  // treat "we started this turn" as "we finished it" — an ordinary send failure (not just a crash)
  // would then make a legitimate retry silently report "sent" without ever composing/sending anything.
  const replyTurnId = deps.idGenerator?.(message) ?? `${message.id}:reply`;
  if (history.some((t) => t.id === replyTurnId)) {
    return { status: "sent" }; // already fully answered in a prior attempt — never re-send
  }

  // An oversized message.text is bounded BEFORE anything else uses it: truncated (with a notice) for
  // normal processing, or — beyond refuseChars — skips routing/compose entirely for a fixed, honest
  // decline (§10 "extremely large -> polite refusal, still one reply"). Never store the raw oversized
  // text in Memory either, or a huge blob just moves from "in the prompt" to "in the next prompt."
  const bounded = message.text !== undefined ? boundInboundText(message.text, deps.inboundTextLimits ?? DEFAULT_INBOUND_TEXT_LIMITS) : undefined;
  const effectiveText = bounded ? (bounded.refuse ? OVERSIZED_PLACEHOLDER : bounded.text) : message.text;

  // Guarded the same way as the reply turn below: a retry of a message whose PREVIOUS attempt
  // persisted the user turn but failed before sending must not re-append it. This can't rely on the
  // Memory backend itself being idempotent-by-id (that's an implementation detail of
  // createLibsqlMemory, not part of the Memory interface's contract) — a non-deduping backend would
  // otherwise accumulate duplicate turns in history across every retry before an eventual success.
  if (!history.some((t) => t.id === message.id)) {
    const now = deps.clock.now();
    await safeAppend(deps.memory, { id: message.id, contactId: message.contactId, role: "user", text: effectiveText, timestamp: now });
  }

  let reply: SmartMessage;
  if (bounded?.refuse) {
    reply = { text: REFUSAL_TEXT };
  } else {
    trace(deps.tracer, "router", "route");
    let decision: RouterDecision;
    try {
      decision = await deps.router.route({ message: { ...message, text: effectiveText }, history, availableSkills: deps.skills?.names() ?? [], availableTools: [] });
    } catch {
      decision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };
    }

    const confident = decision.confidence >= (deps.confidenceThreshold ?? 0.3);
    // §10 "out-of-scope ask -> honest decline": a standing instruction, not special-cased branching —
    // the model is trusted to say so plainly rather than guess when a request is genuinely unrelated
    // to what it's configured to help with.
    const promptParts: string[] = [SCOPE_GUARDRAIL, effectiveText ?? "(no text)"];

    if (confident && decision.skill) {
      const skill = await safeCall(async () => deps.skills?.get(decision.skill!), undefined);
      if (skill) {
        trace(deps.tracer, "skill", "selected", { skill: skill.name });
        promptParts.unshift(skill.promptFragment);
      }
    }

    if (confident && decision.needsRAG && deps.retrieveRag) {
      trace(deps.tracer, "rag", "retrieve");
      const snippets = await safeCall(() => deps.retrieveRag!({ contactId: message.contactId, query: effectiveText ?? "" }), []);
      if (snippets.length > 0) promptParts.push(`Relevant context:\n${snippets.join("\n")}`);
    }

    if (confident && decision.needsTool && deps.invokeTools) {
      trace(deps.tracer, "tools", "invoke");
      const findings = await safeCall(() => deps.invokeTools!({ message, decision }), []);
      if (findings.length > 0) promptParts.push(`Tool results:\n${findings.join("\n")}`);
    }

    if (decision.escalate && deps.onEscalate) {
      await safeCall(async () => {
        await deps.onEscalate!(message, decision);
        return undefined;
      }, undefined);
    }

    trace(deps.tracer, "llm", "compose");
    reply = await composeSmartMessage({ model: deps.model, prompt: promptParts.join("\n\n"), history });
  }

  const channelSystem = KNOWN_TRACED_CHANNELS.has(deps.channel.name) ? (deps.channel.name as TracedSystem) : undefined;
  if (channelSystem) trace(deps.tracer, channelSystem, "send");
  let result: DeliveryResult;
  try {
    result = await deps.channel.send(message.contactId, reply);
  } catch (e) {
    result = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  // Only record the agent as having replied when something actually reached the user — a "failed"/
  // "queued" result must not leave a turn in history claiming the agent said something it didn't,
  // which would otherwise get fed back to the model as prior context on the contact's next message.
  //
  // Uses summarizeReply(), not reply.text directly, since a buttons/list/cta/media-only SmartMessage
  // has no `text` at all (§6.3 — the model is free to choose this from the start, not gated behind a
  // future milestone). On "fellBack" the channel actually delivered renderNumberedFallback()'s plain
  // text, not this summary — an acceptable approximation (same offer, reworded) rather than plumbing
  // the literal delivered text back through DeliveryResult, but worth revisiting if that mismatch
  // ever matters (e.g. the numbered options' exact wording becomes something the model must recall).
  if (result.status === "sent" || result.status === "fellBack") {
    await safeAppend(deps.memory, { id: replyTurnId, contactId: message.contactId, role: "agent", text: summarizeReply(reply), timestamp: deps.clock.now() });
  }

  return result;
}
