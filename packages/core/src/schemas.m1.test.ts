import { describe, expect, test } from "vitest";
import {
  DeliveryResultSchema,
  InboundMessageSchema,
  RouterDecisionSchema,
  SmartMessageSchema,
  ToolResultSchema,
  TurnSchema,
  smartMessageJsonSchema,
} from "./schemas.js";

const baseInbound = { id: "wamid.1", contactId: "c1", channel: "whatsapp", timestamp: 0 };
const btn = (n: number) => ({ id: `b${n}`, title: `button ${n}` });
const row = (n: number) => ({ id: `r${n}`, title: `row ${n}` });

describe("InboundMessage", () => {
  test("accepts minimal message", () => {
    expect(InboundMessageSchema.safeParse(baseInbound).success).toBe(true);
  });
  test("rejects missing id/contactId", () => {
    expect(InboundMessageSchema.safeParse({ ...baseInbound, id: "" }).success).toBe(false);
    expect(InboundMessageSchema.safeParse({ channel: "whatsapp", timestamp: 0 }).success).toBe(false);
  });
});

describe("SmartMessage — accept/reject table (§6.1 structural limits)", () => {
  test.each([
    ["text only", { text: "hi" }, true],
    ["empty object", {}, false],
    ["1 button", { text: "hi", buttons: [btn(1)] }, true],
    ["3 buttons (max)", { text: "hi", buttons: [btn(1), btn(2), btn(3)] }, true],
    ["4 buttons (over max)", { text: "hi", buttons: [btn(1), btn(2), btn(3), btn(4)] }, false],
    ["0 buttons", { text: "hi", buttons: [] }, false],
    [
      "10 rows total (max)",
      { text: "hi", list: { buttonText: "Pick", sections: [{ rows: Array.from({ length: 10 }, (_, i) => row(i)) }] } },
      true,
    ],
    [
      "11 rows total (over max)",
      { text: "hi", list: { buttonText: "Pick", sections: [{ rows: Array.from({ length: 11 }, (_, i) => row(i)) }] } },
      false,
    ],
    ["cta", { text: "hi", cta: { text: "Shop", url: "https://example.com" } }, true],
    ["cta with bad url", { text: "hi", cta: { text: "Shop", url: "not-a-url" } }, false],
    [
      "media only",
      { media: { kind: "image", url: "https://example.com/a.png" } },
      true,
    ],
    [
      "over-length button title is ALLOWED (truncated at send time, M4)",
      { text: "hi", buttons: [{ id: "b1", title: "x".repeat(500) }] },
      true,
    ],
    [
      "over-length list row title/description ALLOWED (truncated at send time, M4)",
      {
        text: "hi",
        list: { buttonText: "Pick", sections: [{ rows: [{ id: "r1", title: "x".repeat(500), description: "y".repeat(500) }] }] },
      },
      true,
    ],
  ])("%s", (_name, input, expected) => {
    expect(SmartMessageSchema.safeParse(input).success).toBe(expected);
  });

  test("flow slot is reserved and unvalidated", () => {
    expect(SmartMessageSchema.safeParse({ text: "hi", flow: { anything: true } }).success).toBe(true);
  });

  test("smartMessageJsonSchema is exported for the model to emit against", () => {
    expect(smartMessageJsonSchema).toBeTypeOf("object");
    expect(smartMessageJsonSchema).toHaveProperty("properties");
  });
});

describe("DeliveryResult", () => {
  test.each([
    ["sent, no reason", { status: "sent" }, true],
    ["failed, no reason -> reject", { status: "failed" }, false],
    ["failed, with reason -> accept", { status: "failed", reason: "meta 131026" }, true],
    ["fellBack, with reason -> accept", { status: "fellBack", reason: "buttons rejected" }, true],
    ["queued, no reason", { status: "queued" }, true],
    ["bad status", { status: "bogus" }, false],
  ])("%s", (_name, input, expected) => {
    expect(DeliveryResultSchema.safeParse(input).success).toBe(expected);
  });
});

describe("Turn", () => {
  test("accepts a user turn", () => {
    expect(TurnSchema.safeParse({ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 0 }).success).toBe(true);
  });
  test("rejects bad role", () => {
    expect(TurnSchema.safeParse({ id: "t1", contactId: "c1", role: "bot", timestamp: 0 }).success).toBe(false);
  });
});

describe("RouterDecision — confidence bounds", () => {
  const base = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false };
  test.each([
    [0, true],
    [0.5, true],
    [1, true],
    [-0.01, false],
    [1.01, false],
  ])("confidence=%s -> %s", (confidence, expected) => {
    expect(RouterDecisionSchema.safeParse({ ...base, confidence }).success).toBe(expected);
  });
});

describe("ToolResult", () => {
  test("accepts ok result with data", () => {
    expect(ToolResultSchema.safeParse({ toolName: "getOrder", ok: true, data: { id: 1 } }).success).toBe(true);
  });
  test("accepts failed result with error", () => {
    expect(ToolResultSchema.safeParse({ toolName: "getOrder", ok: false, error: "timeout" }).success).toBe(true);
  });
});
