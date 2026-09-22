import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { systemClock } from "@wappy/core";
import type { InboundMessage, Model, RouterDecision, Tool } from "@wappy/core";
import { createAgent } from "./agent.js";

// Regression: found by hand-testing a real Shopify-connected conversation. createAgent used to
// call router.route() with a hardcoded `availableTools: []`, so the router's own prompt literally
// said "Available tools: (none)" even when real tools were wired — biasing it toward never setting
// needsTool. "show me your products" was declined even though searchProducts existed and worked.

function msg(): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "show me your products", timestamp: 0 };
}
function textModel(text = "reply"): Model {
  return { generate: async () => ({ structured: { text } }) };
}
const NEEDS_TOOL: RouterDecision = { intent: "products", needsRAG: false, needsTool: true, escalate: false, confidence: 0.9 };

describe("createAgent — the router is told which tools actually exist", () => {
  test("router.route() receives the real tool names, not an empty array", async () => {
    const router = fakeRouter([NEEDS_TOOL]);
    const searchProducts: Tool = { name: "searchProducts", description: "search", parameters: { type: "object", properties: {} }, execute: async () => ({ toolName: "searchProducts", ok: true, data: [] }) };
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router,
      model: textModel(),
      clock: systemClock,
      tools: [searchProducts],
    });

    await agent.handle(msg());

    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.availableTools).toEqual(["searchProducts"]);
  });

  test("no tools wired at all -> still an empty array, not a crash (deps.tools undefined)", async () => {
    const router = fakeRouter([{ intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }]);
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router, model: textModel(), clock: systemClock });

    await agent.handle(msg());

    expect(router.calls[0]!.availableTools).toEqual([]);
  });
});
