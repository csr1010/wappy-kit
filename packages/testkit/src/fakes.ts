import {
  InboundMessageSchema,
  ToolResultSchema,
  TurnSchema,
  RouterDecisionSchema,
  type DeliveryResult,
  type InboundMessage,
  type JsonSchema,
  type Memory,
  type MessageChannel,
  type Router,
  type RouterDecision,
  type RouterInput,
  type SmartMessage,
  type Tool,
  type ToolProvider,
  type ToolResult,
  type Turn,
} from "@wappy/core";

/** Minimal MessageChannel: receive() treats `raw` as (an array of) partial InboundMessage data; `{ statusOnly: true }` -> []. */
export interface FakeChannel extends MessageChannel {
  sent: Array<{ to: string; message: SmartMessage }>;
  failNextSend(status: "failed" | "fellBack", reason: string): void;
}

export function fakeChannel(name = "fake"): FakeChannel {
  const sent: FakeChannel["sent"] = [];
  const scripted: DeliveryResult[] = [];
  let seq = 0;
  return {
    name,
    sent,
    receive(rawWebhook: unknown) {
      if (rawWebhook == null) return [];
      if (typeof rawWebhook === "object" && "statusOnly" in (rawWebhook as Record<string, unknown>)) return [];
      const items = Array.isArray(rawWebhook) ? rawWebhook : [rawWebhook];
      return items.map((raw) => {
        const partial = raw as Partial<InboundMessage>;
        return InboundMessageSchema.parse({
          id: partial.id ?? `fake-${++seq}`,
          contactId: partial.contactId ?? "fake-contact",
          channel: partial.channel ?? name,
          text: partial.text,
          media: partial.media,
          timestamp: partial.timestamp ?? 0,
          raw: partial.raw ?? raw,
        });
      });
    },
    async send(to, message) {
      const next = scripted.shift();
      sent.push({ to, message });
      return next ?? { status: "sent", messageId: `fake-msg-${sent.length}` };
    },
    failNextSend(status, reason) {
      scripted.push({ status, reason });
    },
  };
}

/** In-memory Memory: load()/append() are contact-scoped; recall() returns canned snippets keyed by "contactId:query". */
export interface FakeMemory extends Memory {
  turns: Turn[];
  recallResults: Map<string, string[]>;
}

export function fakeMemory(): FakeMemory {
  const byContact = new Map<string, Turn[]>();
  const turns: Turn[] = [];
  const recallResults = new Map<string, string[]>();
  return {
    turns,
    recallResults,
    async load(contactId) {
      return [...(byContact.get(contactId) ?? [])];
    },
    async append(turn) {
      const parsed = TurnSchema.parse(turn);
      turns.push(parsed);
      const list = byContact.get(parsed.contactId) ?? [];
      list.push(parsed);
      byContact.set(parsed.contactId, list);
    },
    async recall(contactId, query) {
      return recallResults.get(`${contactId}:${query}`) ?? [];
    },
  };
}

/** Scripted Router: `decisions` is either a fixed sequence (last entry repeats) or a function of the input. */
export interface FakeRouter extends Router {
  calls: RouterInput[];
}

const DEFAULT_DECISION: RouterDecision = { intent: "unknown", needsRAG: false, needsTool: false, escalate: false, confidence: 1 };

export function fakeRouter(decisions: RouterDecision[] | ((input: RouterInput) => RouterDecision) = [DEFAULT_DECISION]): FakeRouter {
  const calls: RouterInput[] = [];
  let i = 0;
  return {
    calls,
    async route(input) {
      calls.push(input);
      const raw =
        typeof decisions === "function"
          ? decisions(input)
          : (decisions[Math.min(i++, decisions.length - 1)] ?? DEFAULT_DECISION);
      return RouterDecisionSchema.parse(raw);
    },
  };
}

export interface FakeToolDef {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  readOnly?: boolean;
  confirmBefore?: boolean;
  result?: ToolResult | ((args: unknown) => ToolResult);
}

/** Builds a ToolProvider from plain result scripts; every execute() call is recorded in `calls`. */
export interface FakeToolProvider extends ToolProvider {
  calls: Array<{ name: string; args: unknown }>;
}

export function fakeToolProvider(name: string, defs: FakeToolDef[]): FakeToolProvider {
  const calls: FakeToolProvider["calls"] = [];
  const tools: Tool[] = defs.map((d) => ({
    name: d.name,
    description: d.description ?? d.name,
    parameters: d.parameters ?? {},
    readOnly: d.readOnly ?? true,
    confirmBefore: d.confirmBefore ?? false,
    async execute(args) {
      calls.push({ name: d.name, args });
      const raw = typeof d.result === "function" ? d.result(args) : (d.result ?? { toolName: d.name, ok: true });
      return ToolResultSchema.parse(raw);
    },
  }));
  return { name, calls, listTools: () => tools };
}
