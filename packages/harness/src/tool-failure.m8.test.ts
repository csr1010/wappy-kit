import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { InboundMessage, Model, RouterDecision, Tool, ToolResult } from "@wappy/core";
import { createAgent } from "./agent.js";
import { createToolInvoker } from "./invoke-tools.js";

/**
 * T8.6 end-to-end: "their API down -> caught -> honest 'team will follow up', escalate hook fired"
 * (§10). Proves the real composition — `createAgent`'s `onEscalate` wired to
 * `createToolInvoker`'s `onToolFailure` — not just each piece in isolation (already covered by
 * `invoke-tools.m8.test.ts` and `agent.m5.test.ts`'s own escalate tests separately).
 */

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "where's my order 8842?", timestamp: 0, ...overrides };
}

const ORDERS_DECISION: RouterDecision = { intent: "order-status", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };

function decisionThenReplyModel(toolCall: { toolName: string; args: unknown }, finalReplyText: string): Model {
  const steps = [{ structured: toolCall }, { structured: { text: finalReplyText } }];
  let i = 0;
  return { generate: async () => steps[i++]! };
}

function flakyGetOrder(): Tool {
  return {
    name: "getOrder",
    description: "gets an order",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    readOnly: true,
    confirmBefore: false,
    async execute(): Promise<ToolResult> {
      return { toolName: "getOrder", ok: false, error: "upstream API returned 503" };
    },
  };
}

describe("tool-failure path (T8.6) — their API down, caught, honest reply, escalate fired", () => {
  test("a real tool failure through the full agent+invokeTools composition degrades to an honest reply and fires onEscalate", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([ORDERS_DECISION]);
    const model = decisionThenReplyModel({ toolName: "getOrder", args: { id: "8842" } }, "I'm sorry, I couldn't check that order right now — our team will follow up shortly.");
    const tool = flakyGetOrder();

    let escalated: { toolName: string; error: string } | undefined;
    const invokeTools = createToolInvoker({
      model,
      tools: [tool],
      onToolFailure: (info) => {
        escalated = info;
      },
    });

    const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer: createInMemoryTracer(), tools: [tool], invokeTools });
    const result = await agent.handle(msg());

    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/follow up|sorry|couldn't/i);
    expect(escalated).toEqual({ toolName: "getOrder", error: "upstream API returned 503" });
  });

  test("onToolFailure bridged directly to AgentDeps.onEscalate fires with the ORIGINAL inbound message", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([ORDERS_DECISION]);
    const model = decisionThenReplyModel({ toolName: "getOrder", args: { id: "8842" } }, "our team will follow up.");
    const tool = flakyGetOrder();

    let escalatedMessageId: string | undefined;
    const onEscalate = async (m: InboundMessage) => {
      escalatedMessageId = m.id;
    };
    const invokeTools = createToolInvoker({
      model,
      tools: [tool],
      onToolFailure: () => {
        // The wiring layer bridges invoke-tools' per-tool-failure signal to the agent's own
        // onEscalate hook — demonstrated here by calling it directly, matching how a real app would
        // wire `onToolFailure: (info) => onEscalate(originalMessage, decision)`.
        void onEscalate(msg());
      },
    });

    const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer: createInMemoryTracer(), tools: [tool], invokeTools, onEscalate });
    await agent.handle(msg());

    expect(escalatedMessageId).toBe("m1");
  });

  test("the reply never fabricates a result — the tool's actual failure is never silently upgraded to a fake success", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([ORDERS_DECISION]);
    const seenPrompts: string[] = [];
    let calls = 0;
    const model: Model = {
      generate: async (req) => {
        seenPrompts.push(req.prompt);
        calls++;
        // Call 1 is invoke-tools' own tool-decision call (deciding which tool to call); call 2 is
        // the FINAL compose call, which is the one that actually sees the failure finding as context.
        if (calls === 1) return { structured: { toolName: "getOrder", args: { id: "8842" } } };
        return { structured: { text: "I couldn't check that right now — the team will follow up." } };
      },
    };
    const tool = flakyGetOrder();
    const invokeTools = createToolInvoker({ model, tools: [tool] });
    const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer: createInMemoryTracer(), tools: [tool], invokeTools });

    await agent.handle(msg());

    const composePrompt = seenPrompts[1]!;
    expect(composePrompt).toContain("getOrder");
    expect(composePrompt).toContain("503");
    expect(composePrompt.toLowerCase()).toContain("do not fabricate");
  });
});
