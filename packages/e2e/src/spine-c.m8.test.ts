import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, mockModel, mockWhatsAppCloud } from "@wappy/testkit";
import { createInMemoryTracer, systemClock } from "@wappy/core";
import type { Memory, Turn } from "@wappy/core";
import { createWhatsAppChannel } from "@wappy/whatsapp";
import { createAgent, createLlmRouter, createOrdersSkill, createSkillRegistry, createToolInvoker } from "@wappy/harness";
import { createShopifyToolProvider } from "@wappy/tools-openapi";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Spine C (§9 Scenario C): "where's my order 8842?" — the real tool path. Real @wappy/whatsapp +
 * real @wappy/harness (createAgent, the orders reference skill, the REAL `createToolInvoker`) + the
 * REAL Shopify GraphQL connector (`@wappy/tools-openapi`'s `createShopifyToolProvider`, no live
 * network — a recorded fixture response via a scripted `fetchImpl`, per T8.7's own "mock
 * Shopify/OpenAPI server" and the milestone's "recorded fixture responses (no live network)"
 * requirement) + a scripted mockModel. Proves: `rag` is never touched, and `getOrder` is called
 * exactly once with the order id actually extracted from the message.
 */
test('Spine C — "where\'s my order 8842?" touches exactly {whatsapp, memory, router, skill, tools, llm}, getOrder called exactly once with id 8842, rag never touched', async () => {
  const whatsapp = await mockWhatsAppCloud();

  let shopifyCalls = 0;
  let seenVariables: unknown;
  const shopifyFetchImpl = async (_url: string | URL, init?: RequestInit) => {
    shopifyCalls++;
    const body = JSON.parse(init!.body as string) as { variables: unknown };
    seenVariables = body.variables;
    return jsonResponse({
      data: {
        // A bare digit order id like "8842" (extracted from the user's own message) is a
        // customer-facing order NUMBER, not Shopify's opaque internal numeric id — the connector
        // looks it up via the orders search filter, not order(id:) directly (see shopify.ts's
        // getOrder for why: a model-extracted bare number is never that internal id).
        orders: {
          edges: [
            {
              node: {
                id: "gid://shopify/Order/1",
                name: "#8842",
                displayFulfillmentStatus: "IN_TRANSIT",
                displayFinancialStatus: "PAID",
                createdAt: "2026-01-05T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "42.00", currencyCode: "USD" } },
                fulfillments: [{ trackingInfo: [{ number: "1Z999AA1", url: "https://track.example.com/1Z999AA1" }] }],
              },
            },
          ],
        },
      },
    });
  };

  const shopify = createShopifyToolProvider({
    name: "shopify",
    graphqlUrlOverride: "https://shop.example.myshopify.com/admin/api/2026-07/graphql.json",
    accessTokenEnvVar: "TEST_SHOPIFY_TOKEN",
    envReader: () => "shpat_fixture_token",
    ssrf: { allowPrivateNetworks: true, fetchImpl: shopifyFetchImpl as never },
  });
  const tools = shopify.listTools();

  const model = mockModel([
    { structured: { intent: "order-status", skill: "orders", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 } }, // router's decision
    { structured: { toolName: "getOrder", args: { id: "8842" } } }, // invokeTools' tool decision
    { structured: { formatRationale: "test rationale", message: { text: "Your order #8842 is in transit — tracking 1Z999AA1, expected soon!" } } }, // grounded compose reply
  ]);
  const tracer = createInMemoryTracer();
  const memory = inMemoryMemory();
  const skills = createSkillRegistry();
  skills.register(createOrdersSkill());
  const invokeTools = createToolInvoker({ model, tools });

  const channel = createWhatsAppChannel({ phoneNumberId: "106540352242922", accessToken: "test-token", graphApiBaseUrl: whatsapp.url, clock: systemClock });
  const router = createLlmRouter({ model });
  const agent = createAgent({ channel, memory, router, model, clock: systemClock, tracer, skills, tools, invokeTools });

  tracer.record("whatsapp", "receive");
  const messages = await channel.receive(INBOUND_ORDER_STATUS);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe("where's my order 8842?");

  const results = await Promise.all(messages.map((m) => agent.handle(m)));

  expect(results).toEqual([{ status: "sent", messageId: "wamid.1" }]);
  expect(whatsapp.sent).toHaveLength(1);
  expect(model.calls).toHaveLength(3); // router + tool-decision + compose

  expect(tracer.touched()).toEqual(new Set(["whatsapp", "memory", "router", "skill", "tools", "llm"]));
  expect(tracer.events().filter((e) => e.system === "llm")).toHaveLength(1);
  expect(tracer.events().filter((e) => e.system === "rag")).toHaveLength(0);

  // The real Shopify GraphQL call happened exactly once, searching by the order NUMBER extracted
  // from the message (not misrouted to a direct id lookup by Shopify's own opaque internal id).
  expect(shopifyCalls).toBe(1);
  expect(seenVariables).toEqual({ q: 'name:"#8842"' });

  await whatsapp.close();
});
