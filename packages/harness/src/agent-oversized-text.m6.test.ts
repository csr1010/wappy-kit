import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { InboundMessage, Model, RouterDecision } from "@wappy/core";
import { createAgent } from "./agent.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0, ...overrides };
}

const GREETING: RouterDecision = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };

describe("createAgent — oversized inbound text (§10 T6.7)", () => {
  test("text over refuseChars gets a fixed polite decline — still exactly one reply, no routing/compose", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    let routerCalled = false;
    let modelCalled = false;
    const agent = createAgent({
      channel,
      memory,
      router: { route: async () => { routerCalled = true; return GREETING; } },
      model: { generate: async () => { modelCalled = true; return { text: "should not be reached" }; } },
      clock: systemClock,
      tracer: createInMemoryTracer(),
      inboundTextLimits: { maxChars: 100, refuseChars: 1000 },
    });
    const result = await agent.handle(msg({ text: "x".repeat(5000) }));
    expect(result.status).toBe("sent");
    expect(channel.sent).toHaveLength(1);
    expect(routerCalled).toBe(false);
    expect(modelCalled).toBe(false);
    expect(channel.sent[0]?.message.text).toMatch(/too long/i);
  });

  test("the oversized raw text is never stored in memory — a placeholder is persisted instead", async () => {
    const memory = fakeMemory();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory,
      router: fakeRouter([GREETING]),
      model: { generate: async () => ({ text: "ok" }) },
      clock: systemClock,
      tracer: createInMemoryTracer(),
      inboundTextLimits: { maxChars: 100, refuseChars: 1000 },
    });
    await agent.handle(msg({ text: "x".repeat(5000) }));
    const userTurn = memory.turns.find((t) => t.role === "user");
    expect(userTurn?.text?.length).toBeLessThan(1000);
  });

  test("text over maxChars but under refuseChars is truncated (with a notice) and still routes/composes normally", async () => {
    let seenText: string | undefined;
    const model: Model = { generate: async (req) => { seenText = req.prompt; return { text: "ok, got it" }; } };
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model,
      clock: systemClock,
      tracer: createInMemoryTracer(),
      inboundTextLimits: { maxChars: 50, refuseChars: 1000 },
    });
    const result = await agent.handle(msg({ text: "y".repeat(500) }));
    expect(result.status).toBe("sent");
    expect(seenText).toContain("truncated");
    expect(seenText!.length).toBeLessThan(500);
  });

  test("text within limits is completely unaffected", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model: { generate: async () => ({ text: "hi!" }) },
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg({ text: "short message" }));
    expect(result.status).toBe("sent");
  });

  test("a textless (media-only) message is never bounded/refused, regardless of limits", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model: { generate: async () => ({ text: "got your media" }) },
      clock: systemClock,
      tracer: createInMemoryTracer(),
      inboundTextLimits: { maxChars: 1, refuseChars: 2 },
    });
    const result = await agent.handle(msg({ text: undefined }));
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toBe("got your media");
  });
});
