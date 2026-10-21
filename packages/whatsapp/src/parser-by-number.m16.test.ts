import { describe, expect, test } from "vitest";
import { parseWebhookByNumber, parseWebhookPayload } from "./parser.js";

const change = (pid: string | undefined, messages: unknown[] = [], statuses: unknown[] = []) => ({
  field: "messages",
  value: { messaging_product: "whatsapp", metadata: pid ? { phone_number_id: pid, display_phone_number: `+1 ${pid}` } : {}, messages, statuses },
});
const text = (id: string, from: string, body: string) => ({ id, from, timestamp: "1700000000", type: "text", text: { body } });

describe("M16: parseWebhookByNumber — one webhook, many business numbers", () => {
  test("groups messages and statuses by the number they arrived on, merging repeats in order", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        { id: "waba1", changes: [change("111", [text("a", "c1", "hi")])] },
        { id: "waba2", changes: [change("222", [text("b", "c2", "yo")], [{ id: "out1", status: "read", timestamp: "1700000001", recipient_id: "c2" }])] },
        { id: "waba1", changes: [change("111", [text("c", "c1", "again")])] },
      ],
    };
    const batches = parseWebhookByNumber(payload);
    expect(batches.map((b) => [b.phoneNumberId, b.displayPhoneNumber, b.messages.map((m) => m.text), b.statuses.length])).toEqual([
      ["111", "+1 111", ["hi", "again"], 0],
      ["222", "+1 222", ["yo"], 1],
    ]);
  });

  test("a change with no phone_number_id is dropped here but still counted by the flat parser", () => {
    const payload = { entry: [{ changes: [change(undefined, [text("x", "c9", "lost")]), change("111", [text("y", "c1", "kept")])] }] };
    expect(parseWebhookByNumber(payload).map((b) => b.messages.map((m) => m.id))).toEqual([["y"]]);
    expect(parseWebhookPayload(payload).messages.map((m) => m.id)).toEqual(["x", "y"]);
  });

  test("never throws on garbage", () => {
    for (const junk of [null, 42, "x", { entry: "no" }, { entry: [{ changes: [null, { field: "messages", value: 7 }] }] }]) {
      expect(parseWebhookByNumber(junk)).toEqual([]);
    }
  });
});
