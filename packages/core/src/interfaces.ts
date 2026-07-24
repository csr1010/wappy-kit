import type { DeliveryResult, InboundMessage, RouterDecision, SmartMessage, ToolResult, Turn } from "./schemas.js";

/** JSON Schema object, as produced by zod's toJSONSchema and consumed by Model tool-calling. */
export type JsonSchema = Record<string, unknown>;

/** A single callable tool (§3, §8). */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Never mutates external state; safe to auto-call without confirmation. */
  readOnly: boolean;
  /** Requires explicit user/operator confirmation before executing, regardless of readOnly. */
  confirmBefore: boolean;
  execute(args: unknown): Promise<ToolResult>;
}

/** Generates Tools from a source (OpenAPI spec, Shopify, custom code) (§3, §8). */
export interface ToolProvider {
  name: string;
  listTools(): Promise<Tool[]> | Tool[];
}

/** Prompt fragment + tools + optional memory schema for one capability (§17 glossary). */
export interface Skill {
  name: string;
  description: string;
  promptFragment: string;
  /** Names of tools (from registered ToolProviders) this skill may use. */
  tools?: string[];
  /** Opaque, skill-owned shape persisted alongside Memory; core never interprets it. */
  memorySchema?: unknown;
}

/**
 * receive() returns an array: one webhook payload may batch several message
 * events, or contain zero when it's a status/read-receipt-only notification
 * (§6.2). send() takes an explicit recipient because a channel serves many
 * contacts.
 */
export interface MessageChannel {
  name: string;
  receive(rawWebhook: unknown): Promise<InboundMessage[]> | InboundMessage[];
  send(to: string, message: SmartMessage): Promise<DeliveryResult>;
}

export interface Memory {
  load(contactId: string): Promise<Turn[]>;
  append(turn: Turn): Promise<void>;
  /** Semantic recall scoped to one contact's history/knowledge. Returns text snippets. */
  recall(contactId: string, query: string): Promise<string[]>;
}

export interface RouterInput {
  message: InboundMessage;
  history: Turn[];
  availableSkills: string[];
  availableTools: string[];
}

export interface Router {
  route(input: RouterInput): Promise<RouterDecision>;
}

export interface ModelToolCall {
  name: string;
  args: unknown;
}

export interface ModelRequest {
  prompt: string;
  /** Sent as a system-role message when the underlying adapter supports it — kept separate from `prompt` so structured role separation survives even when the caller has already assembled everything into one deterministic prompt string (T6.2). */
  system?: string;
  history?: Turn[];
  tools?: Tool[];
  /** e.g. smartMessageJsonSchema, when the model must emit a SmartMessage (§6.3). */
  responseSchema?: JsonSchema;
}

export interface ModelResult {
  text?: string;
  structured?: unknown;
  toolCalls?: ModelToolCall[];
}

/** The model port — Vercel AI SDK or any provider sits behind this (§2.1). */
export interface Model {
  generate(req: ModelRequest): Promise<ModelResult>;
}

/** Orchestrates a single inbound message -> reply, wiring Router/Memory/Tools/Channel/Model (§3). */
export interface Agent {
  handle(message: InboundMessage): Promise<DeliveryResult>;
}
