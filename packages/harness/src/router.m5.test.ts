import { describe, expect, test } from "vitest";
import { runRouterConformance } from "@wappy/testkit";
import type { InboundMessage, Model, ModelRequest, ModelResult, RouterInput } from "@wappy/core";
import { createLlmRouter } from "./router.js";

const baseMessage: InboundMessage = { id: "m1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0 };

function baseInput(overrides: Partial<RouterInput> = {}): RouterInput {
  return { message: baseMessage, history: [], availableSkills: [], availableTools: [], ...overrides };
}

function scriptedModel(fn: (req: ModelRequest) => ModelResult): Model {
  return { generate: async (req) => fn(req) };
}

describe("createLlmRouter — conformance", () => {
  test("passes runRouterConformance with a well-behaved model", async () => {
    const model = scriptedModel(() => ({ structured: { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 } }));
    const router = createLlmRouter({ model });
    const violations = await runRouterConformance(router, { input: baseInput() });
    expect(violations).toEqual([]);
  });
});

describe("createLlmRouter — decision table", () => {
  test("a well-formed structured decision is returned as-is", async () => {
    const decision = { intent: "hours", skill: "store-info", needsRAG: true, needsTool: false, escalate: false, confidence: 0.8 };
    const model = scriptedModel(() => ({ structured: decision }));
    const router = createLlmRouter({ model });
    expect(await router.route(baseInput())).toEqual(decision);
  });

  test("the prompt sent to the model includes the message text and available skills/tools", async () => {
    let seenPrompt = "";
    const model = scriptedModel((req) => {
      seenPrompt = req.prompt;
      return { structured: { intent: "hours", needsRAG: true, needsTool: false, escalate: false, confidence: 0.8 } };
    });
    const router = createLlmRouter({ model });
    await router.route(baseInput({ message: { ...baseMessage, text: "what are your store hours?" }, availableSkills: ["store-info"], availableTools: ["getOrder"] }));
    expect(seenPrompt).toContain("what are your store hours?");
    expect(seenPrompt).toContain("store-info");
    expect(seenPrompt).toContain("getOrder");
  });

  test("recent history is included in the prompt for context", async () => {
    let seenPrompt = "";
    const model = scriptedModel((req) => {
      seenPrompt = req.prompt;
      return { structured: { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0.5 } };
    });
    const router = createLlmRouter({ model });
    await router.route(baseInput({ history: [{ id: "t1", contactId: "c1", role: "user", text: "earlier question", timestamp: 0 }] }));
    expect(seenPrompt).toContain("earlier question");
  });

  test("a textless history turn (e.g. media-only) shows a placeholder instead of an empty/undefined line", async () => {
    let seenPrompt = "";
    const model = scriptedModel((req) => {
      seenPrompt = req.prompt;
      return { structured: { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0.5 } };
    });
    const router = createLlmRouter({ model });
    await router.route(baseInput({ history: [{ id: "t1", contactId: "c1", role: "user", timestamp: 0 }] }));
    expect(seenPrompt).toContain("(no text)");
  });

  test("a textless current message (e.g. media-only) shows a placeholder instead of an empty/undefined line", async () => {
    let seenPrompt = "";
    const model = scriptedModel((req) => {
      seenPrompt = req.prompt;
      return { structured: { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0.5 } };
    });
    const router = createLlmRouter({ model });
    await router.route(baseInput({ message: { ...baseMessage, text: undefined } }));
    expect(seenPrompt).toContain("Latest message: (no text)");
  });
});

describe("createLlmRouter — malformed output handling", () => {
  test("garbage (schema-invalid) structured output falls back to a safe default after one repair attempt, not a crash", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
      calls++;
      return { structured: { notEvenARouterDecision: true } };
    });
    const router = createLlmRouter({ model });
    const decision = await router.route(baseInput());
    expect(decision).toEqual({ intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 });
    expect(calls).toBe(2); // one repair attempt, then give up
  });

  test("a repair attempt that succeeds on the second try is used, and its prompt differs from the original (not a blind identical retry)", async () => {
    let calls = 0;
    const seenPrompts: string[] = [];
    const model = scriptedModel((req) => {
      calls++;
      seenPrompts.push(req.prompt);
      if (calls === 1) return { structured: { garbage: true } };
      return { structured: { intent: "hours", needsRAG: true, needsTool: false, escalate: false, confidence: 0.7 } };
    });
    const router = createLlmRouter({ model });
    const decision = await router.route(baseInput());
    expect(decision).toEqual({ intent: "hours", needsRAG: true, needsTool: false, escalate: false, confidence: 0.7 });
    expect(calls).toBe(2);
    expect(seenPrompts[1]).not.toBe(seenPrompts[0]);
    expect(seenPrompts[1]).toContain(seenPrompts[0]);
  });

  test("no structured field at all (model ignored the schema) is also treated as malformed", async () => {
    const model = scriptedModel(() => ({ text: "sure, I can help with that!" }));
    const router = createLlmRouter({ model });
    expect(await router.route(baseInput())).toEqual({ intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 });
  });

  test("the model throwing is caught and treated the same as malformed output, never propagated", async () => {
    const model: Model = { generate: async () => { throw new Error("model API is down"); } };
    const router = createLlmRouter({ model });
    const decision = await router.route(baseInput());
    expect(decision).toEqual({ intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 });
  });

  test("out-of-range confidence (e.g. 1.5) is malformed, not silently clamped", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
      calls++;
      return { structured: { intent: "hours", needsRAG: false, needsTool: false, escalate: false, confidence: 1.5 } };
    });
    const router = createLlmRouter({ model });
    const decision = await router.route(baseInput());
    expect(decision.confidence).toBe(0); // fell back to the safe default, didn't clamp 1.5 -> 1
    expect(calls).toBe(2);
  });
});
