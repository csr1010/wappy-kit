import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { cleanupAllTmpProjects, mockModel, mockWhatsAppCloud } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { Memory, Turn } from "@wappy/core";
import { createWhatsAppChannel } from "@wappy/whatsapp";
import { createAgent, createKnowledge, createKnowledgeRag, createLlmRouter, createSkillRegistry, STORE_INFO_SKILL } from "@wappy/harness";

afterEach(() => cleanupAllTmpProjects());

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INBOUND_STORE_HOURS = JSON.parse(readFileSync(resolve(root, "fixtures/whatsapp/inbound/store-hours.json"), "utf8"));

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
 * Spine B (§9 Scenario B): "what are your store hours?" — the knowledge/RAG path. Real
 * @wappy/whatsapp + real @wappy/harness (createAgent, the store-info reference skill, a REAL
 * `Knowledge` store ingested with a distinctively-markered chunk) + a scripted mockModel +
 * mockWhatsAppCloud. Proves: `tools` is never touched, the router/skill/RAG pipeline actually runs,
 * and the retrieved chunk's own distinctive marker reaches the compose prompt verbatim (grounding —
 * not a paraphrase or a hallucinated answer).
 */
test('Spine B — "what are your store hours?" touches exactly {whatsapp, memory, router, skill, rag, llm}, grounded in the retrieved chunk, tools never touched', async () => {
  const whatsapp = await mockWhatsAppCloud();
  const knowledge = createKnowledge({ client: createClient({ url: ":memory:" }) });
  await knowledge.ingest("hours-policy", "CHUNK-HOURS-001: Our store is open 9am to 6pm, Monday through Saturday. We are closed on Sundays and public holidays.");
  const retrieveRag = createKnowledgeRag({ knowledge });

  const model = mockModel([
    { structured: { intent: "hours", skill: "store-info", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 } }, // router's decision
    { structured: { formatRationale: "test rationale", message: { text: "We're open 9am–6pm, Monday to Saturday, and closed Sundays and holidays." } } }, // the grounded compose reply
  ]);
  const tracer = createInMemoryTracer();
  const memory = inMemoryMemory();
  const skills = createSkillRegistry();
  skills.register(STORE_INFO_SKILL);

  const channel = createWhatsAppChannel({
    phoneNumberId: "106540352242922",
    accessToken: "test-token",
    graphApiBaseUrl: whatsapp.url,
    clock: systemClock,
  });
  const router = createLlmRouter({ model });
  const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, skills, retrieveRag });

  tracer.record("whatsapp", "receive");
  const messages = await channel.receive(INBOUND_STORE_HOURS);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe("what are your store hours?");

  const results = await Promise.all(messages.map((m) => agent.handle(m)));

  expect(results).toEqual([{ status: "sent", messageId: "wamid.1" }]);
  expect(whatsapp.sent).toHaveLength(1);
  expect(model.calls).toHaveLength(2); // one router classification + one grounded compose — no tool-decision call

  expect(tracer.touched()).toEqual(new Set(["whatsapp", "memory", "router", "skill", "rag", "llm"]));
  expect(tracer.events().filter((e) => e.system === "llm")).toHaveLength(1);
  expect(tracer.events().filter((e) => e.system === "tools")).toHaveLength(0);

  // The compose call actually saw the retrieved chunk's distinctive marker — grounded, not guessed.
  const composePrompt = model.calls[1]!.prompt as string;
  expect(composePrompt).toContain("CHUNK-HOURS-001");
  expect(composePrompt).toContain("9am to 6pm");

  await whatsapp.close();
});

test("Spine B — an empty Knowledge store recalls nothing; the compose prompt carries no fabricated chunk", async () => {
  const whatsapp = await mockWhatsAppCloud();
  const knowledge = createKnowledge({ client: createClient({ url: ":memory:" }) }); // never ingested
  const retrieveRag = createKnowledgeRag({ knowledge });

  const model = mockModel([
    { structured: { intent: "hours", skill: "store-info", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 } },
    { structured: { formatRationale: "test rationale", message: { text: "I don't have that information on hand — I'll have the team follow up with the exact hours." } } },
  ]);
  const tracer = createInMemoryTracer();
  const memory = inMemoryMemory();
  const skills = createSkillRegistry();
  skills.register(STORE_INFO_SKILL);

  const channel = createWhatsAppChannel({ phoneNumberId: "106540352242922", accessToken: "test-token", graphApiBaseUrl: whatsapp.url, clock: systemClock });
  const router = createLlmRouter({ model });
  const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, skills, retrieveRag });

  const messages = await channel.receive(INBOUND_STORE_HOURS);
  await Promise.all(messages.map((m) => agent.handle(m)));

  const composePrompt = model.calls[1]!.prompt as string;
  expect(composePrompt).not.toContain("CHUNK-HOURS-001");

  await whatsapp.close();
});
