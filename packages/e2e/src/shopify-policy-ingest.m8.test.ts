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
import { fetchShopifyPolicies, shopifyPolicyIngestDocuments } from "@wappy/tools-openapi";

afterEach(() => cleanupAllTmpProjects());

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INBOUND_REFUND_QUESTION = JSON.parse(readFileSync(resolve(root, "fixtures/whatsapp/inbound/refund-question.json"), "utf8"));

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Closes the RAG-ingestion gap surfaced by the M9 interview simulation (2026-09-21): before this,
 * nothing in Wappy Kit ever called `Knowledge.ingest()` — a store owner's actual policy text had no
 * path into RAG at all. This proves the real, narrow fix end to end: `fetchShopifyPolicies()` pulls
 * the store's own `refundPolicy` from a real (fixture-backed) Shopify GraphQL call,
 * `shopifyPolicyIngestDocuments()` shapes it, a REAL `Knowledge` store ingests it, and a WhatsApp
 * question is answered grounded in that fetched-not-hand-typed text — proving the wiring the CLI/e2e
 * layer is responsible for under hub-and-spoke (tools-openapi and harness never import each other).
 */
test("Shopify policy auto-ingest — a refundPolicy fetched from Shopify grounds a real RAG answer, no hand-typed chunk", async () => {
  const whatsapp = await mockWhatsAppCloud();

  let shopifyCalls = 0;
  const shopifyFetchImpl = async (_url: string | URL, init?: RequestInit) => {
    shopifyCalls++;
    const body = JSON.parse(init!.body as string) as { variables: unknown };
    expect(body.variables).toBeUndefined(); // fetchShopifyPolicies is a static, argument-free query
    return jsonResponse({
      data: {
        shop: {
          shippingPolicy: null,
          refundPolicy: { title: "Refund Policy", body: "<p>CHUNK-REFUND-001: Returns are accepted within 45 days of delivery, with a receipt.</p>" },
          privacyPolicy: null,
          termsOfService: null,
        },
      },
    });
  };

  const fetched = await fetchShopifyPolicies({
    graphqlUrlOverride: "https://luna-co.myshopify.com/admin/api/2026-07/graphql.json",
    accessTokenEnvVar: "SHOPIFY_ACCESS_TOKEN",
    envReader: () => "shpat_ingest_test_token",
    ssrf: { allowPrivateNetworks: true, fetchImpl: shopifyFetchImpl as never },
  });
  expect(fetched.ok).toBe(true);
  if (!fetched.ok) throw new Error("unreachable");
  expect(fetched.policies).toHaveLength(1); // only refundPolicy was configured
  expect(shopifyCalls).toBe(1);

  const knowledge = createKnowledge({ client: createClient({ url: ":memory:" }) });
  for (const doc of shopifyPolicyIngestDocuments(fetched.policies)) {
    await knowledge.ingest(doc.sourceId, doc.text);
  }
  const retrieveRag = createKnowledgeRag({ knowledge });

  const model = mockModel([
    { structured: { intent: "refund-policy", skill: "store-info", needsRAG: true, needsTool: false, escalate: false, confidence: 0.9 } }, // router's decision
    { structured: { formatRationale: "test rationale", message: { text: "You can return items within 45 days of delivery as long as you have your receipt." } } }, // grounded compose reply
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

  const messages = await channel.receive(INBOUND_REFUND_QUESTION);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe("what's your return policy?");

  const results = await Promise.all(messages.map((m) => agent.handle(m)));

  expect(results).toEqual([{ status: "sent", messageId: "wamid.1" }]);
  expect(whatsapp.sent).toHaveLength(1);

  // The grounded compose call's prompt must contain the fetched-from-Shopify chunk's own
  // distinctive marker — proving the answer traces back to the REAL fetched policy text, not a
  // hallucination and not a hand-typed test fixture standing in for ingestion.
  const composeCall = model.calls[1]!;
  expect(composeCall.prompt).toContain("CHUNK-REFUND-001");
  expect(composeCall.prompt).toContain("45 days");

  const sentBody = whatsapp.sent[0]!.body as { text?: { body?: string } };
  expect(sentBody.text?.body).toContain("45 days");

  await whatsapp.close();
});
