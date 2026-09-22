import { describe, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer } from "@wappy/core";
import type { Clock, InboundMessage, Model, RouterDecision, Tool, ToolResult } from "@wappy/core";
import { createAgent } from "./agent.js";
import { cancelSelectionId, confirmSelectionId, createConfirmFlow } from "./confirm.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "confirm", timestamp: 0, ...overrides };
}

function textModel(text = "reply"): Model {
  return { generate: async () => ({ structured: { formatRationale: "test rationale", message: { text } } }) };
}

const GREETING: RouterDecision = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };

function fakeClock(startAt = 1_000_000): Clock & { advance(ms: number): void } {
  let now = startAt;
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined, sleep: async () => undefined, advance: (ms) => (now += ms) };
}

function cancelOrderTool(execute: (args: unknown) => Promise<ToolResult>): Tool {
  return { name: "cancelOrder", description: "cancels an order", parameters: { type: "object", properties: {} }, readOnly: false, confirmBefore: true, execute };
}

describe("createAgent — confirm-before-write flow (T8.5)", () => {
  test("without deps.confirmFlow configured, a well-formed confirm selectionId is routed normally (no interception)", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([GREETING]);
    let routed = false;
    const routerSpy = { route: async (input: Parameters<typeof router.route>[0]) => { routed = true; return router.route(input); } };
    const agent = createAgent({ channel, memory, router: routerSpy, model: textModel("hi there"), clock: fakeClock(), tracer: createInMemoryTracer() });
    const result = await agent.handle(msg({ selectionId: confirmSelectionId("anything"), text: "Confirm" }));
    expect(routed).toBe(true);
    expect(result.status).toBe("sent");
  });

  test("a confirm selectionId with nothing pending gets an honest 'nothing to confirm' reply, router never runs", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const router = fakeRouter([GREETING]);
    let routed = false;
    const routerSpy = { route: async (input: Parameters<typeof router.route>[0]) => { routed = true; return router.route(input); } };
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const agent = createAgent({ channel, memory, router: routerSpy, model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow });
    const result = await agent.handle(msg({ selectionId: confirmSelectionId("nonexistent"), text: "Confirm" }));
    expect(routed).toBe(false);
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/nothing.*pending/i);
  });

  test("confirm executes the pending tool exactly once, with the persisted args, and replies 'Done'", async () => {
    let calls = 0;
    let seenArgs: unknown;
    const tool = cancelOrderTool(async (args) => {
      calls++;
      seenArgs = args;
      return { toolName: "cancelOrder", ok: true, data: {} };
    });
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });

    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });
    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pending.id), text: "Confirm" }));

    expect(calls).toBe(1);
    expect(seenArgs).toEqual({ id: "1001" });
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/^Done/);
    expect(await confirmFlow.getPending("c1")).toBeUndefined();
  });

  test("a duplicate confirm delivery (retry) after the first is fully handled does NOT re-execute the tool", async () => {
    let calls = 0;
    const tool = cancelOrderTool(async () => {
      calls++;
      return { toolName: "cancelOrder", ok: true, data: {} };
    });
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    await agent.handle(msg({ id: "m1", selectionId: confirmSelectionId(pending.id), text: "Confirm" }));
    const second = await agent.handle(msg({ id: "m2", selectionId: confirmSelectionId(pending.id), text: "Confirm" }));

    expect(calls).toBe(1);
    expect(second.status).toBe("sent");
    expect(channel.sent[1]?.message.text).toMatch(/nothing.*pending/i);
  });

  test("cancel discards the pending confirmation without ever executing the tool", async () => {
    let executed = false;
    const tool = cancelOrderTool(async () => {
      executed = true;
      return { toolName: "cancelOrder", ok: true, data: {} };
    });
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    const result = await agent.handle(msg({ selectionId: cancelSelectionId(pending.id), text: "Cancel" }));

    expect(executed).toBe(false);
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/canceled/i);
    expect(await confirmFlow.getPending("c1")).toBeUndefined();
  });

  test("an expired pending confirmation is never executed — confirm after expiry gets the honest 'nothing pending' reply", async () => {
    const tool = cancelOrderTool(async () => ({ toolName: "cancelOrder", ok: true, data: {} }));
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const clock = fakeClock();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock, ttlMs: 1000 });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: {}, summary: "cancelOrder" });
    clock.advance(1001);

    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock, tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });
    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pending.id), text: "Confirm" }));
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/nothing.*pending/i);
  });

  test("an unrelated message while a confirmation is pending is routed normally and does NOT resolve or discard it", async () => {
    const tool = cancelOrderTool(async () => ({ toolName: "cancelOrder", ok: true, data: {} }));
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: {}, summary: "cancelOrder" });
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel("sure, how can I help?"), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    const result = await agent.handle(msg({ id: "m9", selectionId: undefined, text: "actually, what are your hours?" }));

    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toBe("sure, how can I help?");
    // still pending — untouched by the unrelated message
    expect(await confirmFlow.getPending("c1")).toBeDefined();
  });

  test("a STALE confirm button (from a confirmation that's since been replaced by a newer one) does NOT execute the newer action — confused-deputy protection", async () => {
    let calls = 0;
    let seenArgs: unknown;
    const tool = cancelOrderTool(async (args) => {
      calls++;
      seenArgs = args;
      return { toolName: "cancelOrder", ok: true, data: {} };
    });
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });

    // Prompt A: agent asks to cancel order 1001. The user never taps its buttons.
    const pendingA = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });
    // A second, unrelated confirmation (prompt B) later replaces A as the contact's one pending confirmation.
    const pendingB = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "9999" }, summary: "cancelOrder with 9999" });
    expect(pendingA.id).not.toBe(pendingB.id);

    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    // The user's phone still shows prompt A's old "Confirm" button — a stale tap on it arrives now.
    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pendingA.id), text: "Confirm" }));

    expect(calls).toBe(0); // must NOT have executed order 9999 (prompt B's action)
    expect(seenArgs).toBeUndefined();
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/isn't valid anymore|no longer valid/i);
    // prompt B is STILL pending — the stale tap on A must not have discarded it either
    const stillPending = await confirmFlow.getPending("c1");
    expect(stillPending?.id).toBe(pendingB.id);
  });

  test("after a stale-button rejection, the genuine current confirmation can still be confirmed normally", async () => {
    let calls = 0;
    const tool = cancelOrderTool(async () => {
      calls++;
      return { toolName: "cancelOrder", ok: true, data: {} };
    });
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pendingA = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "1001" }, summary: "cancelOrder with 1001" });
    const pendingB = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: { id: "9999" }, summary: "cancelOrder with 9999" });

    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    await agent.handle(msg({ id: "m1", selectionId: confirmSelectionId(pendingA.id), text: "Confirm" })); // stale, rejected
    const second = await agent.handle(msg({ id: "m2", selectionId: confirmSelectionId(pendingB.id), text: "Confirm" })); // genuine

    expect(calls).toBe(1);
    expect(second.status).toBe("sent");
    expect(channel.sent[1]?.message.text).toMatch(/^Done/);
  });

  test("a legacy bare 'confirm'/'cancel' selectionId (no embedded id) is NOT treated as a confirm reply — routed normally instead", async () => {
    const tool = cancelOrderTool(async () => ({ toolName: "cancelOrder", ok: true, data: {} }));
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: {}, summary: "cancelOrder" });
    const router = fakeRouter([GREETING]);
    let routed = false;
    const routerSpy = { route: async (input: Parameters<typeof router.route>[0]) => { routed = true; return router.route(input); } };
    const agent = createAgent({ channel, memory, router: routerSpy, model: textModel("hi"), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    const result = await agent.handle(msg({ selectionId: "confirm", text: "Confirm" }));

    expect(routed).toBe(true);
    expect(result.status).toBe("sent");
    // the genuinely pending confirmation is untouched by this malformed/legacy selectionId
    expect(await confirmFlow.getPending("c1")).toBeDefined();
  });

  test("a failed tool execution on confirm reports an honest failure and fires onEscalate", async () => {
    const tool = cancelOrderTool(async () => ({ toolName: "cancelOrder", ok: false, error: "upstream 503" }));
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: {}, summary: "cancelOrder" });
    let escalated = false;
    const agent = createAgent({
      channel,
      memory,
      router: fakeRouter([GREETING]),
      model: textModel(),
      clock: fakeClock(),
      tracer: createInMemoryTracer(),
      confirmFlow,
      tools: [tool],
      onEscalate: async () => { escalated = true; },
    });

    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pending.id), text: "Confirm" }));

    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toContain("503");
    expect(channel.sent[0]?.message.text).toMatch(/follow up/i);
    expect(escalated).toBe(true);
  });

  test("a failed tool execution with no `error` field still reports honestly (falls back to 'unknown error')", async () => {
    const tool = cancelOrderTool(async () => ({ toolName: "cancelOrder", ok: false }));
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "cancelOrder", args: {}, summary: "cancelOrder" });
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [tool] });

    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pending.id), text: "Confirm" }));

    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toContain("unknown error");
  });

  test("a pending confirmation for a tool no longer in deps.tools fails honestly instead of crashing", async () => {
    const channel = fakeChannel("whatsapp");
    const memory = fakeMemory();
    const confirmFlow = createConfirmFlow({ client: createClient({ url: ":memory:" }), clock: fakeClock() });
    const pending = await confirmFlow.request({ contactId: "c1", toolName: "goneTool", args: {}, summary: "goneTool" });
    const agent = createAgent({ channel, memory, router: fakeRouter([GREETING]), model: textModel(), clock: fakeClock(), tracer: createInMemoryTracer(), confirmFlow, tools: [] });

    const result = await agent.handle(msg({ selectionId: confirmSelectionId(pending.id), text: "Confirm" }));
    expect(result.status).toBe("sent");
    expect(channel.sent[0]?.message.text).toMatch(/couldn't complete/i);
  });
});
