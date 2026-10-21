import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy_ai/testkit";
import { createInMemoryTracer, systemClock } from "@wappy_ai/core";
import type { InboundMessage, Model, RouterDecision, Skill, WappyApp } from "@wappy_ai/core";
import { createAgent } from "./agent.js";
import { createSkillRegistry, registerApps } from "./skills.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "hello", timestamp: 0, ...overrides };
}

const GREETING: RouterDecision = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };

/** A model that fails the test if it is ever called. */
function forbiddenModel(): Model & { calls: number } {
  const m = { calls: 0, generate: async () => { m.calls++; throw new Error("model must not be called"); } };
  return m;
}

const echoSkill: Skill = {
  name: "echo",
  description: "Repeats the message",
  promptFragment: "",
  respond: ({ message }) => (message.text ? `Echo: ${message.text}` : undefined),
};

describe("M16: Skill.respond — a skill can answer without the model", () => {
  test("a responding skill replies, persists both turns, and never calls the router or model", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const model = forbiddenModel();
    const tracer = createInMemoryTracer();
    const skills = createSkillRegistry();
    skills.register(echoSkill);
    let routed = 0;
    const router = { route: async () => { routed++; return GREETING; } };
    const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, skills });

    const result = await agent.handle(msg());

    expect(result.status).toBe("sent");
    expect(channel.sent).toEqual([{ to: "c1", message: { text: "Echo: hello" } }]);
    expect(memory.turns.map((t) => [t.role, t.text])).toEqual([["user", "hello"], ["agent", "Echo: hello"]]);
    expect(model.calls).toBe(0);
    expect(routed).toBe(0);
    expect(tracer.touched().has("skill")).toBe(true);
    expect(tracer.touched().has("llm")).toBe(false);
  });

  test("returning undefined falls through to the normal route + compose path", async () => {
    const channel = fakeChannel("whatsapp");
    const skills = createSkillRegistry();
    skills.register({ ...echoSkill, respond: () => undefined });
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "from the model" } } }) };
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer(), skills });
    await agent.handle(msg());
    expect(channel.sent[0].message).toEqual({ text: "from the model" });
  });

  test("the first registered responder that answers wins; a structured SmartMessage is sent as-is", async () => {
    const channel = fakeChannel("whatsapp");
    const skills = createSkillRegistry();
    skills.register({ name: "stop", description: "opt-out", promptFragment: "", respond: ({ message }) => (message.text === "STOP" ? { text: "You're unsubscribed." } : undefined) });
    skills.register(echoSkill);
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: forbiddenModel(), clock: systemClock, tracer: createInMemoryTracer(), skills });
    await agent.handle(msg({ id: "a", text: "STOP" }));
    await agent.handle(msg({ id: "b", text: "hi" }));
    expect(channel.sent.map((s) => s.message.text)).toEqual(["You're unsubscribed.", "Echo: hi"]);
  });

  test("a responder that throws is skipped, never crashes the reply", async () => {
    const channel = fakeChannel("whatsapp");
    const skills = createSkillRegistry();
    skills.register({ name: "broken", description: "", promptFragment: "", respond: () => { throw new Error("boom"); } });
    skills.register(echoSkill);
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: forbiddenModel(), clock: systemClock, tracer: createInMemoryTracer(), skills });
    await agent.handle(msg());
    expect(channel.sent[0].message).toEqual({ text: "Echo: hello" });
  });

  test("an empty-string response counts as no answer and falls through", async () => {
    const channel = fakeChannel("whatsapp");
    const skills = createSkillRegistry();
    skills.register({ ...echoSkill, respond: async () => "" });
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "from the model" } } }) };
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: systemClock, tracer: createInMemoryTracer(), skills });
    await agent.handle(msg());
    expect(channel.sent[0].message).toEqual({ text: "from the model" });
  });

  test("a replayed message (same id) is not answered twice", async () => {
    const channel = fakeChannel("whatsapp");
    const skills = createSkillRegistry();
    skills.register(echoSkill);
    const agent = createAgent({ channel, memory: fakeMemory(), router: fakeRouter([GREETING]), model: forbiddenModel(), clock: systemClock, tracer: createInMemoryTracer(), skills });
    await agent.handle(msg());
    await agent.handle(msg());
    expect(channel.sent).toHaveLength(1);
  });
});

describe("M16: WappyApp — the unit a host installs on a number", () => {
  test("registerApps adds every app's skills, in order, and rejects duplicate skill names", () => {
    const a: WappyApp = { id: "echo", name: "Echo bot", version: "0.1.0", skills: [echoSkill] };
    const b: WappyApp = { id: "stop", name: "Opt-out", version: "0.1.0", skills: [{ name: "stop", description: "", promptFragment: "" }] };
    const registry = createSkillRegistry();
    registerApps(registry, [a, b]);
    expect(registry.names()).toEqual(["echo", "stop"]);
    expect(() => registerApps(createSkillRegistry(), [a, { ...a, id: "echo-2" }])).toThrow(/echo/);
    const toolsOnly: WappyApp = { id: "tools", name: "Tools only", version: "0.1.0" };
    const r2 = createSkillRegistry();
    registerApps(r2, [toolsOnly]);
    expect(r2.names()).toEqual([]);
  });
});
