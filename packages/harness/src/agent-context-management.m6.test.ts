import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { InboundMessage, Model, RouterDecision, Tool, Turn } from "@wappy/core";
import { createAgent } from "./agent.js";
import { createSkillRegistry } from "./skills.js";
import { createContextBudget } from "./context-budget.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0, ...overrides };
}

function turn(i: number): Turn {
  return { id: `t${i}`, contactId: "c1", role: "user", text: `earlier message ${i}`, timestamp: i };
}

function fakeTool(name: string, description: string): Tool {
  return { name, description, parameters: { type: "object", properties: {} }, readOnly: true, confirmBefore: false, execute: async () => ({ toolName: name, ok: true }) };
}

const NEEDS_TOOL: RouterDecision = { intent: "order-status", skill: "orders", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };

describe("createAgent — tool schema selection (T6.5 wired into T6.2's assembler)", () => {
  test("when needsTool, deps.tools are BM25-ranked and their schemas appear in the compose prompt", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "order 8842 has shipped" } }; } };
    const tools = [
      fakeTool("getOrderStatus", "look up order status by order id"),
      fakeTool("getWeather", "fetches the weather forecast"),
    ];
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([NEEDS_TOOL]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
      tools,
    });
    await agent.handle(msg({ text: "where's my order 8842?" }));
    expect(seenPrompt).toContain("getOrderStatus");
    expect(seenPrompt).not.toContain("getWeather");
  });

  test("a skill-declared tool (Skill.tools) is always included in the prompt, bypassing relevance", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "ok" } }; } };
    const skills = createSkillRegistry();
    skills.register({ name: "orders", description: "x", promptFragment: "ORDERS_SKILL", tools: ["getWeather"] });
    const tools = [fakeTool("getWeather", "fetches the weather forecast — totally unrelated to the message")];
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([NEEDS_TOOL]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
      tools,
      skills,
    });
    await agent.handle(msg({ text: "where's my order 8842?" }));
    expect(seenPrompt).toContain("getWeather");
  });

  test("a textless message with needsTool + deps.tools configured doesn't crash (empty query, not undefined)", async () => {
    const tools = [fakeTool("getOrderStatus", "look up order status")];
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([NEEDS_TOOL]),
      model: { generate: async () => ({ structured: { text: "ok" } }) },
      clock: systemClock,
      tracer: createInMemoryTracer(),
      tools,
    });
    const result = await agent.handle(msg({ text: undefined }));
    expect(result.status).toBe("sent");
  });

  test("no deps.tools configured -> no toolSchemas section, no crash", async () => {
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([NEEDS_TOOL]),
      model: { generate: async () => ({ text: "ok" }) },
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });
});

describe("createAgent — context budget wiring (T6.1/T6.2/T6.8)", () => {
  test("a custom contextBudget is actually used — a tiny budget still produces a reply, never crashes", async () => {
    const tinyBudget = createContextBudget("x", { overrides: { contextWindow: 30, reservedOutputTokens: 0 } });
    const model: Model = { generate: async () => ({ structured: { text: "ok" } }) };
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
      contextBudget: tinyBudget,
    });
    const result = await agent.handle(msg({ text: "x".repeat(200) }));
    expect(result.status).toBe("sent");
  });

  test("a context-length error from the model triggers a shrink-and-retry, still resulting in a normal sent reply", async () => {
    let calls = 0;
    const model: Model = {
      generate: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("too many tokens"), { code: "context_length_exceeded" });
        return { structured: { text: "fits now" } };
      },
    };
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toBe("fits now");
    expect(calls).toBe(2);
  });

  test("prompt usage/dropped info is traced under 'llm' for observability (T6.9)", async () => {
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model: { generate: async () => ({ structured: { text: "ok" } }) },
      clock: systemClock,
      tracer,
    });
    await agent.handle(msg());
    const composeEvents = tracer.events().filter((e) => e.system === "llm");
    expect(composeEvents).toHaveLength(1); // exactly one "llm" trace event per compose call
    const usage = (composeEvents[0]?.data as { usage: Record<string, number> } | undefined)?.usage;
    expect(usage?.system).toBeGreaterThan(0);
  });
});

describe("createAgent — history windowing wired in (T6.3)", () => {
  test("a custom maxRecentTurns controls how much history stays verbatim vs. gets summarized", async () => {
    const memory = fakeMemory();
    for (let i = 0; i < 20; i++) await memory.append(turn(i));
    let summarizerCalled = false;
    let seenPrompt = "";
    const model: Model = {
      generate: async (req) => {
        if (req.prompt.includes("Summarize the following")) {
          summarizerCalled = true;
          return { text: "SUMMARY_TEXT" };
        }
        seenPrompt = req.prompt;
        return { structured: { text: "ok" } };
      },
    };
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory,
      router: fakeRouter([{ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
      maxRecentTurns: 5,
    });
    await agent.handle(msg({ id: "m21", text: "hi again" }));
    expect(summarizerCalled).toBe(true);
    expect(seenPrompt).toContain("SUMMARY_TEXT");
    expect(seenPrompt).toContain("earlier message 19"); // most recent of the un-summarized kept turns
    expect(seenPrompt).not.toContain("earlier message 0"); // summarized away
  });

  test("default maxRecentTurns (20) means a short (fresh-contact) history never triggers summarization", async () => {
    let calls = 0;
    const model: Model = { generate: async () => { calls++; return { structured: { text: "ok" } }; } };
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    await agent.handle(msg());
    expect(calls).toBe(1); // only the compose call — no summarization model call for a fresh contact
  });
});
