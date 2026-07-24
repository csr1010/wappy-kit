import type { Skill } from "@wappy/core";

/**
 * Reference skills (§8/§13 T8.4): shipped as generic, working EXAMPLES — not something a real
 * deployment necessarily uses verbatim. Each pairs a prompt fragment with the tools/RAG source it
 * needs; neither contains any domain logic beyond what's here (§13: business logic belongs in an
 * app built ON TOP of Wappy Kit, never in this repo).
 */

/**
 * store-info (Scenario B, "what are your store hours?"): pure RAG, no tools — answers are grounded
 * ONLY in whatever `retrieveRag` (e.g. `createKnowledgeRag`) actually recalls. No `memorySchema`:
 * a store-info lookup is stateless — there's nothing about it worth persisting turn-to-turn beyond
 * the conversation history Memory already keeps.
 */
export const STORE_INFO_SKILL: Skill = {
  name: "store-info",
  description: "Answers questions about store hours, location, shipping, and return policies using ingested knowledge (RAG).",
  promptFragment:
    "You can answer questions about store hours, location, shipping, and return policies. Base your answer ONLY on the retrieved information provided to you — if nothing relevant was retrieved, say honestly that you don't have that information rather than guessing or making something up.",
};

/** Tool names this skill expects a registered `ToolProvider` to expose — matches the Shopify
 * connector's own tool names (`shopify.ts`), but any OpenAPI-generated provider exposing tools under
 * these same names works identically (the skill itself has no Shopify-specific knowledge). */
export const DEFAULT_ORDERS_SKILL_TOOLS = ["getOrder", "listRecentOrders"];

export interface CreateOrdersSkillOptions {
  /** Override if the wired ToolProvider names its order tools differently. Default `DEFAULT_ORDERS_SKILL_TOOLS`. */
  toolNames?: string[];
}

/**
 * orders (Scenario C, "where's my order 8842?"): tool-grounded — looks up real order status via
 * whichever tools are wired in (`invokeTools`/`tools`). `memorySchema` documents (not enforces —
 * core never interprets it) the optional `meta` shape this skill MAY attach to its own reply Turn,
 * for an app that wants to remember the last order a contact asked about across messages; nothing
 * in the OS itself reads or writes it — that's left for an app built on top (§13) to actually use.
 */
export function createOrdersSkill(opts: CreateOrdersSkillOptions = {}): Skill {
  return {
    name: "orders",
    description: "Looks up order status and recent orders using the store's order-management tools.",
    promptFragment:
      "You can look up order status and recent orders using the available tools. Only report what a tool result actually returned — never fabricate an order status, tracking number, or date. If a tool call failed, say so honestly and let the user know the team will follow up.",
    tools: opts.toolNames ?? DEFAULT_ORDERS_SKILL_TOOLS,
    memorySchema: { lastOrderId: "string | undefined — the most recently discussed order id, if an app wants to persist it" },
  };
}
