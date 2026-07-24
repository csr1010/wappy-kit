import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, mockModel, mockWhatsAppCloud } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { Memory, Turn } from "@wappy/core";
import { createWhatsAppChannel } from "@wappy/whatsapp";
import { createAgent, createLlmRouter, createSkillRegistry } from "@wappy/harness";

afterEach(() => cleanupAllTmpProjects());

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INBOUND_HI = JSON.parse(readFileSync(resolve(root, "fixtures/whatsapp/inbound/text.json"), "utf8"));

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
 * Spine A (§9 Scenario A): "hi" works end to end on the cheapest path. Real @wappy/whatsapp
 * (M3+M4) + real @wappy/harness (M5) + a scripted mockModel + mockWhatsAppCloud — only e2e wires
 * these together (hub-and-spoke). Proves the router and the compose step never touch RAG/tools for
 * a plain greeting, and that exactly one LLM (compose) trace event fires — the router's own model
 * call is traced separately, as "router", not "llm" (§7 System One vs System Two).
 */
test("Spine A — \"hi\" touches exactly {whatsapp, memory, router, llm}, one LLM call, zero RAG/tool calls", async () => {
  const whatsapp = await mockWhatsAppCloud();
  const model = mockModel([
    { structured: { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 } }, // router's decision
    { structured: { text: "Hi there! How can I help you today?" } }, // the composed reply
  ]);
  const tracer = createInMemoryTracer();
  const memory = inMemoryMemory();

  const channel = createWhatsAppChannel({
    phoneNumberId: "106540352242922",
    accessToken: "test-token",
    graphApiBaseUrl: whatsapp.url,
    clock: systemClock,
  });
  const router = createLlmRouter({ model });
  const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, skills: createSkillRegistry() });

  tracer.record("whatsapp", "receive");
  const messages = await channel.receive(INBOUND_HI);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe("hi");

  const results = await Promise.all(messages.map((m) => agent.handle(m)));

  expect(results).toEqual([{ status: "sent", messageId: "wamid.1" }]);
  expect(whatsapp.sent).toHaveLength(1);
  expect(model.calls).toHaveLength(2); // one router classification + one compose — nothing else

  expect(tracer.touched()).toEqual(new Set(["whatsapp", "memory", "router", "llm"]));
  expect(tracer.events().filter((e) => e.system === "llm")).toHaveLength(1);
  expect(tracer.events().filter((e) => e.system === "rag" || e.system === "tools" || e.system === "skill")).toHaveLength(0);

  await whatsapp.close();
});
