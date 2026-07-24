import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, mockModel, mockWhatsAppCloud } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { Memory, Tool, Turn } from "@wappy/core";
import { createWhatsAppChannel } from "@wappy/whatsapp";
import { createAgent, createLlmRouter, createToolInvoker } from "@wappy/harness";

afterEach(() => cleanupAllTmpProjects());

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INBOUND_ORDER_STATUS = JSON.parse(readFileSync(resolve(root, "fixtures/whatsapp/inbound/order-status.json"), "utf8"));

function inMemoryMemory(): Memory {
  const byContact = new Map<string, Turn[]>();
  return {
    async load(contactId) {
      return [...(byContact.get(contactId) ?? [])];
    },
    async append(turn) {
      const list = byContact.get(turn.contactId) ?? [];
      list.push(turn);
      byContact.set(turn.contactId, list);
    },
    async recall() {
      return [];
    },
  };
}

/**
 * Spine C (§9 Scenario C): "where's my order 8842?" — the real tool path. Real @wappy/whatsapp +
 * real @wappy/harness (createAgent, the REAL `createToolInvoker`, ZERO skills registered — M12
 * removed the reference skills; this is the milestone's own proof that tool-invocation works fine
 * without a skill wrapper). This repo ships no domain connector anymore (Shopify and everything
 * else moved to a separate connectors repo, see docs/SPEC.md's decisions log) — the `Tool` here is
 * a plain, hand-written one directly satisfying `@wappy/core`'s `Tool` interface, which is exactly
 * what proves the point: the harness's real invocation pipeline (BM25 selection, the tool-decision
 * model call, `tool.execute()`, result formatting) works against ANY conformant `Tool`, not just a
 * connector-shaped one. Proves: `rag` and `skill` are never touched, and `getOrder` is called
 * exactly once with the order id actually extracted from the message.
 */
test('Spine C — "where\'s my order 8842?" touches exactly {whatsapp, memory, router, tools, llm} with zero skills registered (M12), getOrder called exactly once with id 8842, rag/skill never touched', async () => {
  const whatsapp = await mockWhatsAppCloud();

  let getOrderCalls = 0;
  let seenArgs: unknown;
  const getOrderTool: Tool = {
    name: "getOrder",
    description: "Looks up an order's status by its customer-facing order number.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    readOnly: true,
    confirmBefore: false,
    async execute(args) {
      getOrderCalls++;
      seenArgs = args;
      return { toolName: "getOrder", ok: true, data: { orderNumber: "#8842", status: "IN_TRANSIT", tracking: "1Z999AA1" } };
    },
  };
  const tools = [getOrderTool];

  const model = mockModel([
    { structured: { intent: "order-status", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 } }, // router's decision — no skill (M12: none registered)
    { structured: { toolName: "getOrder", args: { id: "8842" } } }, // invokeTools' tool decision
    { structured: { formatRationale: "test rationale", message: { text: "Your order #8842 is in transit — tracking 1Z999AA1, expected soon!" } } }, // grounded compose reply
  ]);
  const tracer = createInMemoryTracer();
  const memory = inMemoryMemory();
  // M12: zero skills registered — `deps.skills` omitted entirely (T12.8's own verification: the
  // agent must work with no skills param at all, not just an empty registry).
  const invokeTools = createToolInvoker({ model, tools });

  const channel = createWhatsAppChannel({ phoneNumberId: "106540352242922", accessToken: "test-token", graphApiBaseUrl: whatsapp.url, clock: systemClock });
  const router = createLlmRouter({ model });
  const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, tools, invokeTools });

  tracer.record("whatsapp", "receive");
  const messages = await channel.receive(INBOUND_ORDER_STATUS);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe("where's my order 8842?");

  const results = await Promise.all(messages.map((m) => agent.handle(m)));

  expect(results).toEqual([{ status: "sent", messageId: "wamid.1" }]);
  expect(whatsapp.sent).toHaveLength(1);
  expect(model.calls).toHaveLength(3); // router + tool-decision + compose

  expect(tracer.touched()).toEqual(new Set(["whatsapp", "memory", "router", "tools", "llm"]));
  expect(tracer.events().filter((e) => e.system === "llm")).toHaveLength(1);
  expect(tracer.events().filter((e) => e.system === "rag")).toHaveLength(0);
  expect(tracer.events().filter((e) => e.system === "skill")).toHaveLength(0);

  // The real Tool was called exactly once, with the order id actually extracted from the message.
  expect(getOrderCalls).toBe(1);
  expect(seenArgs).toEqual({ id: "8842" });

  await whatsapp.close();
});
