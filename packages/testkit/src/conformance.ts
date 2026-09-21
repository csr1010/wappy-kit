import {
  DeliveryResultSchema,
  InboundMessageSchema,
  RouterDecisionSchema,
  ToolResultSchema,
  TurnSchema,
  type Memory,
  type MessageChannel,
  type Router,
  type RouterInput,
  type SmartMessage,
  type ToolProvider,
  type Turn,
} from "@wappy/core";

/**
 * B6 contract conformance suites: run the SAME checks against a fake, a real impl, and every
 * optional backend, so a drift from the interface is caught wherever it happens. Each suite
 * returns a list of violations (empty = conformant) instead of throwing, so callers assert
 * `expect(await runXConformance(...)).toEqual([])` and the suite itself is unit-testable by
 * feeding it a deliberately broken implementation.
 */

const issues = (r: { success: false; error: { issues: { message: string }[] } }) => r.error.issues.map((i) => i.message).join("; ");

export interface ChannelConformanceFixtures {
  /** Must decode to >=1 InboundMessage via receive(). */
  rawWithMessage: unknown;
  /** Optional: must decode to zero InboundMessage via receive() (a status-only webhook, §6.2). */
  rawStatusOnly?: unknown;
  to: string;
  message: SmartMessage;
}

export async function runChannelConformance(impl: MessageChannel, fx: ChannelConformanceFixtures): Promise<string[]> {
  const violations: string[] = [];
  if (typeof impl.name !== "string" || impl.name.length === 0) violations.push("MessageChannel.name must be a non-empty string");

  const msgs = await impl.receive(fx.rawWithMessage);
  if (!Array.isArray(msgs)) {
    violations.push("receive() must return an array");
  } else {
    if (msgs.length === 0) violations.push("receive(rawWithMessage) returned zero messages");
    msgs.forEach((m, i) => {
      const r = InboundMessageSchema.safeParse(m);
      if (!r.success) violations.push(`receive()[${i}] is not a valid InboundMessage: ${issues(r)}`);
    });
  }

  if (fx.rawStatusOnly !== undefined) {
    const none = await impl.receive(fx.rawStatusOnly);
    if (!Array.isArray(none) || none.length !== 0) violations.push("receive(rawStatusOnly) must return an empty array");
  }

  const result = await impl.send(fx.to, fx.message);
  const parsed = DeliveryResultSchema.safeParse(result);
  if (!parsed.success) violations.push(`send() result is not a valid DeliveryResult: ${issues(parsed)}`);

  return violations;
}

export interface MemoryConformanceFixtures {
  contactId: string;
  /** turn.contactId must equal contactId. */
  turn: Turn;
}

export async function runMemoryConformance(impl: Memory, fx: MemoryConformanceFixtures): Promise<string[]> {
  const violations: string[] = [];
  if (fx.turn.contactId !== fx.contactId) {
    violations.push("fixture: turn.contactId must equal fixture contactId");
    return violations;
  }

  const before = await impl.load(fx.contactId);
  if (!Array.isArray(before)) violations.push("load() must return an array");

  await impl.append(fx.turn);
  const after = await impl.load(fx.contactId);
  if (!Array.isArray(after)) {
    violations.push("load() must return an array");
  } else {
    if (!after.some((t) => t.id === fx.turn.id)) violations.push("appended turn is not present in the next load()");
    after.forEach((t, i) => {
      const r = TurnSchema.safeParse(t);
      if (!r.success) violations.push(`load()[${i}] is not a valid Turn: ${issues(r)}`);
    });
  }

  const snippets = await impl.recall(fx.contactId, "anything");
  if (!Array.isArray(snippets) || snippets.some((s) => typeof s !== "string")) {
    violations.push("recall() must return string[]");
  }

  return violations;
}

export interface RouterConformanceFixtures {
  input: RouterInput;
}

export async function runRouterConformance(impl: Router, fx: RouterConformanceFixtures): Promise<string[]> {
  const violations: string[] = [];
  const decision = await impl.route(fx.input);
  const parsed = RouterDecisionSchema.safeParse(decision);
  if (!parsed.success) violations.push(`route() result is not a valid RouterDecision: ${issues(parsed)}`);
  return violations;
}

export interface ToolProviderConformanceFixtures {
  /** args passed to the first listed tool's execute(), to check its result shape. */
  args?: unknown;
}

export async function runToolProviderConformance(impl: ToolProvider, fx: ToolProviderConformanceFixtures = {}): Promise<string[]> {
  const violations: string[] = [];
  if (typeof impl.name !== "string" || impl.name.length === 0) violations.push("ToolProvider.name must be a non-empty string");

  const tools = await impl.listTools();
  if (!Array.isArray(tools)) return [...violations, "listTools() must return an array"];

  const seen = new Set<string>();
  tools.forEach((tool, i) => {
    if (typeof tool.name !== "string" || tool.name.length === 0) violations.push(`tools[${i}] missing name`);
    else if (seen.has(tool.name)) violations.push(`duplicate tool name: ${tool.name}`);
    else seen.add(tool.name);
    if (typeof tool.description !== "string" || tool.description.length === 0) violations.push(`tools[${i}] (${tool.name}) missing description`);
    if (typeof tool.parameters !== "object" || tool.parameters === null) violations.push(`tools[${i}] (${tool.name}) parameters must be a JSON Schema object`);
    if (typeof tool.readOnly !== "boolean") violations.push(`tools[${i}] (${tool.name}) readOnly must be boolean`);
    if (typeof tool.confirmBefore !== "boolean") violations.push(`tools[${i}] (${tool.name}) confirmBefore must be boolean`);
  });

  const first = tools[0];
  if (first) {
    const result = await first.execute(fx.args);
    const parsed = ToolResultSchema.safeParse(result);
    if (!parsed.success) violations.push(`tools[0].execute() result is not a valid ToolResult: ${issues(parsed)}`);
  }

  return violations;
}
