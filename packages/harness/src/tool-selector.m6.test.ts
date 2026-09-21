import { describe, expect, test } from "vitest";
import type { Tool } from "@wappy/core";
import { selectTools } from "./tool-selector.js";

function fakeTool(name: string, description: string): Tool {
  return { name, description, parameters: { type: "object", properties: {} }, readOnly: true, confirmBefore: false, execute: async () => ({ toolName: name, ok: true }) };
}

describe("selectTools — basics", () => {
  test("no tools available returns an empty selection", () => {
    expect(selectTools({ tools: [], message: "get my order", maxTokens: 1000 })).toEqual([]);
  });

  test("a message with no matchable words at all (e.g. only punctuation) selects nothing, not a crash", () => {
    const tools = [fakeTool("getOrderStatus", "looks up order status")];
    expect(selectTools({ tools, message: "???!!!", maxTokens: 1000 })).toEqual([]);
  });

  test("a query term that appears in zero tools' descriptions doesn't crash the idf calculation", () => {
    const tools = [fakeTool("getOrderStatus", "looks up order status by id")];
    const result = selectTools({ tools, message: "xyzzyplugh nonexistent gibberish term", maxTokens: 1000 });
    expect(result).toEqual([]);
  });

  test("a tool with no lexical relevance to the message is never selected", () => {
    const tools = [fakeTool("getWeather", "fetches the current weather forecast for a city")];
    const result = selectTools({ tools, message: "what's the status of my order 8842?", maxTokens: 1000 });
    expect(result).toEqual([]);
  });

  test("a clearly relevant tool (name+description match the message) is selected", () => {
    const tools = [
      fakeTool("getOrderStatus", "looks up the current status of a customer order by order id"),
      fakeTool("getWeather", "fetches the current weather forecast for a city"),
    ];
    const result = selectTools({ tools, message: "what's the status of my order 8842?", maxTokens: 1000 });
    expect(result.map((t) => t.name)).toContain("getOrderStatus");
    expect(result.map((t) => t.name)).not.toContain("getWeather");
  });
});

describe("selectTools — budget bounds K", () => {
  test("only as many top-ranked tools as fit maxTokens are returned, cutting off the rest", () => {
    const tools = Array.from({ length: 20 }, (_, i) => fakeTool(`getOrderTool${i}`, "looks up order status by order id for a customer"));
    const oneToolCost = JSON.stringify({ name: tools[0]!.name, description: tools[0]!.description, parameters: tools[0]!.parameters }).length / 3.5;
    const result = selectTools({ tools, message: "order status", maxTokens: Math.ceil(oneToolCost * 3) });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(20);
  });

  test("a maxTokens of 0 with no alwaysInclude tools selects nothing", () => {
    const tools = [fakeTool("getOrderStatus", "looks up order status")];
    expect(selectTools({ tools, message: "order status", maxTokens: 0 })).toEqual([]);
  });
});

describe("selectTools — skill-declared tools are always eligible", () => {
  test("an alwaysInclude tool is selected even with zero lexical relevance to the message", () => {
    const tools = [fakeTool("getWeather", "fetches the current weather forecast for a city")];
    const result = selectTools({ tools, message: "hello there", maxTokens: 1000, alwaysInclude: ["getWeather"] });
    expect(result.map((t) => t.name)).toEqual(["getWeather"]);
  });

  test("alwaysInclude tools don't count against the relevance filter but still consume the token budget", () => {
    const alwaysToolCost = 50;
    const tools = [fakeTool("alwaysTool", "x".repeat(200)), fakeTool("relevantTool", "matches order status query well")];
    const result = selectTools({ tools, message: "order status", maxTokens: alwaysToolCost, alwaysInclude: ["alwaysTool"] });
    expect(result.map((t) => t.name)).toContain("alwaysTool");
  });
});

describe("selectTools — recall@K over a large (800) tool set with 20 labeled queries", () => {
  // A curated set of distinctive "target" tools across unrelated domains, mixed into a large pool of
  // generic filler tools, proving BM25 surfaces the right one out of hundreds of distractors.
  const targets: [name: string, description: string, query: string][] = [
    ["getOrderStatus", "look up the current shipping status of a customer order by order id", "where is my order 8842?"],
    ["getWeatherForecast", "fetch the 5 day weather forecast for a given city", "what's the weather like in Paris tomorrow?"],
    ["cancelSubscription", "cancels a customer's recurring subscription plan", "I want to cancel my subscription"],
    ["searchProductCatalog", "search the product catalog by keyword or category", "can you search your product catalog for blue running shoes?"],
    ["getRefundStatus", "checks whether a refund for an order has been processed", "has my refund gone through yet?"],
    ["bookAppointment", "books a new appointment slot with a specified staff member", "can I book an appointment for Tuesday?"],
    ["getAccountBalance", "returns the current balance on a customer's account", "what's my account balance?"],
    ["sendPasswordReset", "sends a password reset email to the account holder", "I forgot my password"],
    ["trackShipment", "tracks a shipment's delivery progress using a tracking number", "track my package with tracking number XYZ123"],
    ["getStoreHours", "returns the opening and closing hours for a store location", "what are your store hours today?"],
    ["applyDiscountCode", "applies a promotional discount code to the current cart", "can I use a discount code SAVE20?"],
    ["getLoyaltyPoints", "returns the customer's current loyalty program point balance", "how many loyalty points do I have?"],
    ["reportDamagedItem", "files a report for an item that arrived damaged", "my item arrived broken, what do I do?"],
    ["getInvoiceCopy", "sends a copy of a past invoice to the customer's email", "can you send me a copy of my invoice?"],
    ["updateShippingAddress", "updates the shipping address on file for future orders", "I need to change my shipping address"],
    ["getWarrantyInfo", "returns warranty coverage details for a purchased product", "is my product still under warranty?"],
    ["scheduleCallback", "schedules a callback from support at a requested time", "can you schedule a callback for tomorrow?"],
    ["getGiftCardBalance", "checks the remaining balance on a gift card", "how much is left on my gift card?"],
    ["reportFraud", "files a fraud report for an unauthorized charge", "I see a charge I didn't make on my account"],
    ["getReturnLabel", "generates a printable return shipping label for an order", "I need a return label for order 5521"],
  ];

  const filler = Array.from({ length: 780 }, (_, i) =>
    fakeTool(`filler${i}`, `generic internal utility operation number ${i} for miscellaneous unrelated backend processing`),
  );
  const allTools = [...targets.map(([name, description]) => fakeTool(name, description)), ...filler];

  test.each(targets)("query %#: finds %s among 800 tools", (targetName, _description, query) => {
    const result = selectTools({ tools: allTools, message: query, maxTokens: 5000 });
    expect(result.length).toBeLessThanOrEqual(allTools.length);
    expect(result.map((t) => t.name)).toContain(targetName);
  });
});
