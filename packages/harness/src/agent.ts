import type { Agent, Clock, DeliveryResult, InboundMessage, MessageChannel, Memory, Model, Router, RouterDecision, TracedSystem, Tracer, Turn } from "@wappy/core";
import { composeSmartMessage } from "./compose.js";
import type { SkillRegistry } from "./skills.js";

const SCOPE_GUARDRAIL = "If the user's request is genuinely unrelated to what you're configured to help with, say so honestly and directly rather than guessing or making something up.";

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

  const now = deps.clock.now();
  await safeAppend(deps.memory, { id: message.id, contactId: message.contactId, role: "user", text: message.text, timestamp: now });

  trace(deps.tracer, "router", "route");
  let decision: RouterDecision;
  try {
    decision = await deps.router.route({ message, history, availableSkills: deps.skills?.names() ?? [], availableTools: [] });
  } catch {
    decision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };
  }

  const confident = decision.confidence >= (deps.confidenceThreshold ?? 0.3);
  // §10 "out-of-scope ask -> honest decline": a standing instruction, not special-cased branching —
  // the model is trusted to say so plainly rather than guess when a request is genuinely unrelated
  // to what it's configured to help with.
  const promptParts: string[] = [SCOPE_GUARDRAIL, message.text ?? "(no text)"];

  if (confident && decision.skill) {
    const skill = await safeCall(async () => deps.skills?.get(decision.skill!), undefined);
    if (skill) {
      trace(deps.tracer, "skill", "selected", { skill: skill.name });
      promptParts.unshift(skill.promptFragment);
    }
  }

  if (confident && decision.needsRAG && deps.retrieveRag) {
    trace(deps.tracer, "rag", "retrieve");
    const snippets = await safeCall(() => deps.retrieveRag!({ contactId: message.contactId, query: message.text ?? "" }), []);
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
  const reply = await composeSmartMessage({ model: deps.model, prompt: promptParts.join("\n\n"), history });

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
  if (result.status === "sent" || result.status === "fellBack") {
    await safeAppend(deps.memory, { id: replyTurnId, contactId: message.contactId, role: "agent", text: reply.text, timestamp: deps.clock.now() });
  }

  return result;
}
