import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { InboundMessage, Memory, Model, RouterDecision, Turn } from "@wappy/core";
import { createAgent } from "./agent.js";
import { createSkillRegistry } from "./skills.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0, ...overrides };
}

function textModel(text = "reply"): Model {
  return { generate: async () => ({ structured: { text } }) };
}

const GREETING: RouterDecision = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };

describe("createAgent — happy path (Scenario A: \"hi\")", () => {
  test("loads memory, routes, composes, sends, persists both turns, traces exactly the touched systems", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([GREETING]);
    const model = textModel("Hi! How can I help?");
    const tracer = createInMemoryTracer();
    const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer });

    const result = await agent.handle(msg());

    expect(result).toEqual({ status: "sent", messageId: "fake-msg-1" });
    expect(channel.sent).toEqual([{ to: "c1", message: { text: "Hi! How can I help?" } }]);
    expect(memory.turns.map((t) => ({ role: t.role, text: t.text }))).toEqual([
      { role: "user", text: "hi" },
      { role: "agent", text: "Hi! How can I help?" },
    ]);
    expect(tracer.touched()).toEqual(new Set(["whatsapp", "memory", "router", "llm"]));
  });

  test("a textless message (e.g. media-only) still composes and sends a reply, using a placeholder in the prompt", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "got your photo!" } }; } };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg({ text: undefined }));
    expect(result.status).toBe("sent");
    expect(seenPrompt).toContain("(no text)");
  });

  test("RAG and tools are never touched when the router says neither is needed", async () => {
    const memory = fakeMemory();
    const tracer = createInMemoryTracer();
    let ragCalled = false;
    let toolsCalled = false;
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory,
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer,
      retrieveRag: async () => { ragCalled = true; return []; },
      invokeTools: async () => { toolsCalled = true; return []; },
    });
    await agent.handle(msg());
    expect(ragCalled).toBe(false);
    expect(toolsCalled).toBe(false);
    expect(tracer.touched().has("rag")).toBe(false);
    expect(tracer.touched().has("tools")).toBe(false);
  });
});

describe("createAgent — skill", () => {
  test("a router-selected, registered skill injects its prompt fragment into compose and is traced", async () => {
    const skills = createSkillRegistry();
    skills.register({ name: "store-info", description: "x", promptFragment: "STORE_INFO_FRAGMENT" });
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "hours are 9-5" } }; } };
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "hours", skill: "store-info", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer,
      skills,
    });
    await agent.handle(msg({ text: "hours?" }));
    expect(seenPrompt).toContain("STORE_INFO_FRAGMENT");
    expect(tracer.touched().has("skill")).toBe(true);
  });

  test("a skill named by the router but not registered is ignored, not a crash", async () => {
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "hours", skill: "nonexistent-skill", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]),
      model: textModel(),
      clock: systemClock,
      tracer,
      skills: createSkillRegistry(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(tracer.touched().has("skill")).toBe(false);
  });
});

describe("createAgent — RAG / tools hooks", () => {
  test("needsRAG=true with a retrieveRag hook injects its snippets into compose and is traced", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "we're at 123 Main St" } }; } };
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "location", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer,
      retrieveRag: async () => ["store address: 123 Main St"],
    });
    await agent.handle(msg({ text: "where are you located?" }));
    expect(seenPrompt).toContain("123 Main St");
    expect(tracer.touched().has("rag")).toBe(true);
  });

  test("a textless message triggering RAG queries with an empty string, not undefined/crash", async () => {
    let seenQuery: string | undefined;
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "x", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 }]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      retrieveRag: async (input) => { seenQuery = input.query; return []; },
    });
    await agent.handle(msg({ text: undefined }));
    expect(seenQuery).toBe("");
  });

  test("needsTool=true with an invokeTools hook injects its findings into compose and is traced", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "order 8842 has shipped" } }; } };
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "order-status", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 }]),
      model,
      clock: systemClock,
      tracer,
      invokeTools: async () => ["order 8842: shipped"],
    });
    await agent.handle(msg({ text: "where's my order 8842?" }));
    expect(seenPrompt).toContain("order 8842: shipped");
    expect(tracer.touched().has("tools")).toBe(true);
  });

  test("needsRAG/needsTool=true with no hook configured degrades gracefully — no crash, nothing traced", async () => {
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "x", needsRAG: true, needsTool: true, escalate: false, confidence: 0.9 }]),
      model: textModel(),
      clock: systemClock,
      tracer,
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(tracer.touched().has("rag")).toBe(false);
    expect(tracer.touched().has("tools")).toBe(false);
  });
});

describe("createAgent — confidence gate", () => {
  test("below the confidence threshold, skill/RAG/tool augmentation is suppressed but a reply is still sent (never silent)", async () => {
    const skills = createSkillRegistry();
    skills.register({ name: "store-info", description: "x", promptFragment: "STORE_INFO_FRAGMENT" });
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "not sure, let me check" } }; } };
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "hours", skill: "store-info", needsRAG: true, needsTool: false, escalate: false, confidence: 0.1 }]),
      model,
      clock: systemClock,
      tracer,
      skills,
      retrieveRag: async () => ["should not appear"],
      confidenceThreshold: 0.3,
      idGenerator: () => "agent-reply-1",
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(seenPrompt).not.toContain("STORE_INFO_FRAGMENT");
    expect(seenPrompt).not.toContain("should not appear");
    expect(tracer.touched().has("skill")).toBe(false);
    expect(tracer.touched().has("rag")).toBe(false);
  });
});

describe("createAgent — out-of-scope decline (§10)", () => {
  test("the compose prompt always includes a standing instruction to honestly decline out-of-scope requests", async () => {
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { text: "ok" } }; } };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg());
    expect(seenPrompt).toContain("say so honestly");
  });

  test("when the model honestly declines an out-of-scope request, the Agent sends that decline as-is", async () => {
    const channel = fakeChannel("whatsapp");
    const model = textModel("I'm a store support assistant, so I can't help with that — happy to answer store questions though!");
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg({ text: "what's the capital of France?" }));
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toBe("I'm a store support assistant, so I can't help with that — happy to answer store questions though!");
  });
});

describe("createAgent — escalate", () => {
  test("escalate=true calls the onEscalate hook and still sends a reply", async () => {
    let escalated: { message: InboundMessage; decision: RouterDecision } | undefined;
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "complaint", needsRAG: false, needsTool: false, escalate: true, confidence: 0.8 }]),
      model: textModel("I'm looping in a team member for this."),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      onEscalate: async (message, decision) => { escalated = { message, decision }; },
    });
    const result = await agent.handle(msg({ text: "this is unacceptable" }));
    expect(result.status).toBe("sent");
    expect(escalated?.decision.escalate).toBe(true);
    expect(escalated?.message.id).toBe("m1");
  });
});

describe("createAgent — retry after a failed send (the exact scenario the idempotency fix targets)", () => {
  test("a failed send persists no reply turn, so a retry of the same message actually re-sends for real, not a silent no-op", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });

    channel.failNextSend("failed", "network down");
    const first = await agent.handle(msg());
    expect(first).toEqual({ status: "failed", reason: "network down" });
    expect(memory.turns.filter((t) => t.role === "agent")).toHaveLength(0); // nothing persisted on failure
    expect(memory.turns.filter((t) => t.role === "user")).toHaveLength(1); // the user's message is still recorded

    const second = await agent.handle(msg()); // same message.id, a legitimate retry
    expect(second.status).toBe("sent");
    expect(channel.sent).toHaveLength(2); // both attempts genuinely reached channel.send() — the retry wasn't skipped
    expect(memory.turns.filter((t) => t.role === "agent")).toHaveLength(1); // persisted exactly once, by the retry
    // The retry must not re-append the user's turn a second time — Memory.append isn't required by
    // its own interface to dedupe by id (createLibsqlMemory happens to, but fakeMemory here does not).
    expect(memory.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(memory.turns).toHaveLength(2); // exactly one user turn + one agent turn, total, across both attempts
  });

  test("a queued (window-closed) result also persists no reply turn, so retrying once the window reopens still composes/sends for real", async () => {
    const channel = fakeChannel("whatsapp");
    let calls = 0;
    channel.send = async () => {
      calls++;
      return calls === 1 ? { status: "queued", reason: "window closed" } : { status: "sent", messageId: "wamid.retry" };
    };
    const memory = fakeMemory();
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });

    const first = await agent.handle(msg());
    expect(first).toEqual({ status: "queued", reason: "window closed" });
    expect(memory.turns.filter((t) => t.role === "agent")).toHaveLength(0);

    const second = await agent.handle(msg());
    expect(second).toEqual({ status: "sent", messageId: "wamid.retry" });
    expect(calls).toBe(2);
    expect(memory.turns.filter((t) => t.role === "agent")).toHaveLength(1);
    expect(memory.turns.filter((t) => t.role === "user")).toHaveLength(1); // not duplicated across the retry
  });
});

describe("createAgent — persisting rich (non-text) replies", () => {
  test("a buttons-only reply (no `text`) is still persisted as a readable summary, not lost from memory", async () => {
    const memory = fakeMemory();
    const model: Model = { generate: async () => ({ structured: { buttons: [{ id: "a", title: "Track order" }, { id: "b", title: "Cancel order" }] } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    const agentTurn = memory.turns.find((t) => t.role === "agent");
    expect(agentTurn?.text).toContain("Track order");
    expect(agentTurn?.text).toContain("Cancel order");
  });

  test("a list-only reply is persisted with its row titles summarized", async () => {
    const memory = fakeMemory();
    const model: Model = {
      generate: async () => ({
        structured: { list: { buttonText: "Pick one", sections: [{ rows: [{ id: "a", title: "Size S" }, { id: "b", title: "Size M" }] }] } },
      }),
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg());
    const agentTurn = memory.turns.find((t) => t.role === "agent");
    expect(agentTurn?.text).toContain("Size S");
    expect(agentTurn?.text).toContain("Size M");
  });

  test("a cta-only reply is persisted with its link text and url", async () => {
    const memory = fakeMemory();
    const model: Model = { generate: async () => ({ structured: { cta: { text: "Visit our site", url: "https://example.com" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg());
    const agentTurn = memory.turns.find((t) => t.role === "agent");
    expect(agentTurn?.text).toContain("Visit our site");
    expect(agentTurn?.text).toContain("https://example.com");
  });

  test("a media-only reply with a caption is persisted using the caption", async () => {
    const memory = fakeMemory();
    const model: Model = { generate: async () => ({ structured: { media: { kind: "image", url: "https://example.com/a.png", caption: "our new arrivals" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg());
    const agentTurn = memory.turns.find((t) => t.role === "agent");
    expect(agentTurn?.text).toBe("[image: our new arrivals]");
  });

  test("a media-only reply with no caption is persisted using just the media kind", async () => {
    const memory = fakeMemory();
    const model: Model = { generate: async () => ({ structured: { media: { kind: "video", url: "https://example.com/a.mp4" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg());
    const agentTurn = memory.turns.find((t) => t.role === "agent");
    expect(agentTurn?.text).toBe("[video]");
  });

  test("a persisted rich reply is not silently dropped from the next turn's model context (round-trips through toModelMessages)", async () => {
    const memory = fakeMemory();
    let secondCallHistory: Turn[] | undefined;
    let calls = 0;
    const model: Model = {
      generate: async (req) => {
        calls++;
        if (calls === 1) return { structured: { buttons: [{ id: "a", title: "Track order" }] } };
        secondCallHistory = req.history;
        return { structured: { text: "ok" } };
      },
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    await agent.handle(msg({ id: "m1" }));
    await agent.handle(msg({ id: "m2" }));
    expect(secondCallHistory?.some((t) => t.role === "agent" && t.text?.includes("Track order"))).toBe(true);
  });
});

describe("createAgent — idempotent persist", () => {
  test("replaying the same message id (e.g. a post-crash webhook retry) persists exactly one turn and doesn't re-send", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });

    await agent.handle(msg());
    await agent.handle(msg()); // same message.id again

    expect(memory.turns.filter((t) => t.id === "m1")).toHaveLength(1);
    expect(memory.turns).toHaveLength(2); // one user + one agent turn total, not four
    expect(channel.sent).toHaveLength(1); // never sent twice
  });
});

describe("createAgent — per-contact serialization", () => {
  test("two rapid messages for the same contact are processed strictly in order, never interleaved", async () => {
    const memory = fakeMemory();
    let loadCalls = 0;
    const delayedMemory: Memory = {
      async load(contactId) {
        loadCalls++;
        if (loadCalls === 1) await new Promise((r) => setTimeout(r, 30)); // simulate slow first read
        return memory.load(contactId);
      },
      append: (turn: Turn) => memory.append(turn),
      recall: (contactId: string, query: string) => memory.recall(contactId, query),
    };
    let secondCallHistory: Turn[] | undefined;
    let calls = 0;
    const model: Model = {
      generate: async (req) => {
        calls++;
        if (calls === 2) secondCallHistory = req.history;
        return { structured: { text: `reply ${calls}` } };
      },
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: delayedMemory, router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });

    await Promise.all([agent.handle(msg({ id: "m1", text: "first" })), agent.handle(msg({ id: "m2", text: "second" }))]);

    // If unserialized, msg2's load() could race ahead and see none of msg1's turns.
    expect(secondCallHistory?.some((t) => t.id === "m1")).toBe(true);
    expect(memory.turns).toHaveLength(4); // 2 user + 2 agent, no dupes, no lost writes
  });
});

describe("createAgent — model error/timeout (§10)", () => {
  test("the model failing on both compose attempts still results in an honest reply being sent, not a crash or silence", async () => {
    const channel = fakeChannel("whatsapp");
    const model: Model = { generate: async () => { throw new Error("upstream timeout"); } };
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/try again shortly/i);
  });
});

describe("createAgent — per-step fallbacks", () => {
  test("channel.send() failing (resolving with a failed status) degrades to a failed DeliveryResult, not a thrown exception", async () => {
    const channel = fakeChannel("whatsapp");
    channel.failNextSend("failed", "network down");
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result).toEqual({ status: "failed", reason: "network down" });
  });

  test("channel.send() throwing outright also degrades to a failed DeliveryResult, not a crash", async () => {
    const channel = fakeChannel("whatsapp");
    channel.send = async () => { throw new Error("ECONNRESET"); };
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result).toEqual({ status: "failed", reason: "ECONNRESET" });
  });

  test("channel.send() throwing a non-Error value is still stringified into a readable reason", async () => {
    const channel = fakeChannel("whatsapp");
    channel.send = async () => { throw "socket closed"; };
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: textModel(), clock: systemClock, tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result).toEqual({ status: "failed", reason: "socket closed" });
  });

  test("retrieveRag() throwing degrades to no extra context, reply is still sent", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "x", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 }]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      retrieveRag: async () => { throw new Error("vector db down"); },
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });

  test("invokeTools() throwing degrades to no extra context, reply is still sent", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "x", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 }]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      invokeTools: async () => { throw new Error("their API is down"); },
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });

  test("an unguarded dependency (e.g. a throwing idGenerator) is still caught by the outer safety net, not left as an unhandled rejection", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      idGenerator: () => { throw new Error("id generator misconfigured"); },
    });
    const result = await agent.handle(msg());
    expect(result).toEqual({ status: "failed", reason: "id generator misconfigured" });
  });

  test("an unguarded dependency throwing a non-Error value is still stringified into a readable reason", async () => {
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      idGenerator: () => { throw "not an Error instance"; },
    });
    const result = await agent.handle(msg());
    expect(result).toEqual({ status: "failed", reason: "not an Error instance" });
  });

  test("a channel with a customized, non-standard name is never traced under a garbage TracedSystem label", async () => {
    const tracer = createInMemoryTracer();
    const agent = createAgent({
      channel: fakeChannel("my-custom-channel"),
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer,
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    // Only the known TracedSystem union members should ever appear — "my-custom-channel" must not.
    for (const system of tracer.touched()) {
      expect(["whatsapp", "memory", "router", "skill", "rag", "tools", "llm"]).toContain(system);
    }
  });

  test("onEscalate() throwing doesn't prevent the reply from being sent", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: fakeMemory(),
      router: fakeRouter([{ intent: "complaint", needsRAG: false, needsTool: false, escalate: true, confidence: 0.8 }]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
      onEscalate: async () => { throw new Error("escalation webhook down"); },
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });

  test("router.route() throwing degrades to the router's own safe-default behavior, not a crash", async () => {
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: { route: async () => { throw new Error("router exploded"); } },
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent"); // still replies — never silently drops the user's message
  });

  test("memory.load() throwing degrades to empty history rather than crashing the whole turn", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: { load: async () => { throw new Error("db unavailable"); }, append: async () => {}, recall: async () => [] },
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    expect(channel.sent).toHaveLength(1);
  });

  test("memory.append() throwing doesn't prevent the reply from being sent (persistence is best-effort after the fact)", async () => {
    const channel = fakeChannel("whatsapp");
    const agent = createAgent({
      channel,
      memory: { load: async () => [], append: async () => { throw new Error("disk full"); }, recall: async () => [] },
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: systemClock,
      tracer: createInMemoryTracer(),
    });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });
});
