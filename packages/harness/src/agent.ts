import type { Agent, Clock, DeliveryResult, InboundMessage, MessageChannel, Memory, Model, Router, RouterDecision, TracedSystem, Tracer, Turn } from "@wappy/core";
import { composeSmartMessage } from "./compose.js";
import type { SkillRegistry } from "./skills.js";

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
  /** Id for the agent's own reply Turn. Default: `${message.id}:reply`. */
  idGenerator?: () => string;
}

/**
 * Orchestrates one inbound message -> reply: load memory -> route -> (skill/RAG/tool) -> compose ->
 * confidence gate -> send -> persist -> trace, each step degrading rather than crashing (§9, §10).
 * Per-contact serialized so two rapid messages for the same contact never interleave or double-persist.
 */
export function createAgent(deps: AgentDeps): Agent {
  const chains = new Map<string, Promise<unknown>>();
  // handleOne is exception-safe by construction (every fallible step below has its own fallback),
  // so prev's fulfill/reject handlers are identical: either way, it's this contact's turn to run.
  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const settle = prev.then(fn, fn);
    chains.set(key, settle);
    return settle;
  };

  return {
    handle: (message) => serialize(message.contactId, () => handleOne(message, deps)),
  };
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

async function handleOne(message: InboundMessage, deps: AgentDeps): Promise<DeliveryResult> {
  deps.tracer.record("memory", "load", { contactId: message.contactId });
  const history = await safeLoad(deps.memory, message.contactId);

  if (history.some((t) => t.id === message.id)) {
    // A crash-recovery replay of a webhook already fully handled before (§10) — never re-send.
    return { status: "sent" };
  }

  const now = deps.clock.now();
  await safeAppend(deps.memory, { id: message.id, contactId: message.contactId, role: "user", text: message.text, timestamp: now });

  deps.tracer.record("router", "route");
  let decision: RouterDecision;
  try {
    decision = await deps.router.route({ message, history, availableSkills: deps.skills?.names() ?? [], availableTools: [] });
  } catch {
    decision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };
  }

  const confident = decision.confidence >= (deps.confidenceThreshold ?? 0.3);
  const promptParts: string[] = [message.text ?? "(no text)"];

  if (confident && decision.skill) {
    const skill = deps.skills?.get(decision.skill);
    if (skill) {
      deps.tracer.record("skill", "selected", { skill: skill.name });
      promptParts.unshift(skill.promptFragment);
    }
  }

  if (confident && decision.needsRAG && deps.retrieveRag) {
    deps.tracer.record("rag", "retrieve");
    const snippets = await safeCall(() => deps.retrieveRag!({ contactId: message.contactId, query: message.text ?? "" }), []);
    if (snippets.length > 0) promptParts.push(`Relevant context:\n${snippets.join("\n")}`);
  }

  if (confident && decision.needsTool && deps.invokeTools) {
    deps.tracer.record("tools", "invoke");
    const findings = await safeCall(() => deps.invokeTools!({ message, decision }), []);
    if (findings.length > 0) promptParts.push(`Tool results:\n${findings.join("\n")}`);
  }

  if (decision.escalate && deps.onEscalate) {
    await safeCall(async () => {
      await deps.onEscalate!(message, decision);
      return undefined;
    }, undefined);
  }

  deps.tracer.record("llm", "compose");
  const reply = await composeSmartMessage({ model: deps.model, prompt: promptParts.join("\n\n"), history });

  deps.tracer.record(deps.channel.name as TracedSystem, "send");
  let result: DeliveryResult;
  try {
    result = await deps.channel.send(message.contactId, reply);
  } catch (e) {
    result = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  await safeAppend(deps.memory, { id: deps.idGenerator?.() ?? `${message.id}:reply`, contactId: message.contactId, role: "agent", text: reply.text, timestamp: deps.clock.now() });

  return result;
}
