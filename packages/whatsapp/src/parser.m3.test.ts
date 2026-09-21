import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { InboundMessageSchema } from "@wappy/core";
import { parseWebhookPayload } from "./parser.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesDir = resolve(repoRoot, "fixtures/whatsapp/inbound");
const fixture = (name: string) => JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));

describe("parseWebhookPayload — one scenario per fixture", () => {
  test("text", () => {
    const { messages } = parseWebhookPayload(fixture("text.json"));
    expect(messages).toEqual([
      { id: "wamid.HBgLMTU1NTAwMDIyMjIVAgARGBI1QjJGRTU3NzUxNjBDQjI4RTcA", contactId: "15550002222", channel: "whatsapp", text: "hi", media: undefined, timestamp: 1750000000000, raw: expect.any(Object) },
    ]);
  });

  test("interactive button reply -> text is the button title", () => {
    const { messages } = parseWebhookPayload(fixture("button-reply.json"));
    expect(messages[0]?.text).toBe("Store hours");
  });

  test("interactive list reply -> text is the row title", () => {
    const { messages } = parseWebhookPayload(fixture("list-reply.json"));
    expect(messages[0]?.text).toBe("Order #8842");
  });

  test("image -> media.kind=image, url is the Graph API media id (not yet downloaded)", () => {
    const { messages } = parseWebhookPayload(fixture("image.json"));
    expect(messages[0]?.media).toEqual({ kind: "image", url: "1234567890123456", mimeType: "image/jpeg", caption: "receipt from yesterday" });
  });

  test("audio with voice:true -> media.kind=voice, not audio", () => {
    const { messages } = parseWebhookPayload(fixture("voice-note.json"));
    expect(messages[0]?.media?.kind).toBe("voice");
  });

  test("location -> media.kind=location", () => {
    const { messages } = parseWebhookPayload(fixture("location.json"));
    expect(messages[0]?.media).toEqual({ kind: "location", caption: "Palo Alto store", url: undefined, mimeType: undefined });
  });

  test("reaction -> text is the emoji", () => {
    const { messages } = parseWebhookPayload(fixture("reaction.json"));
    expect(messages[0]?.text).toBe("👍");
  });

  test("unsupported type (sticker) -> never throws, produces a placeholder text", () => {
    const { messages } = parseWebhookPayload(fixture("unsupported-sticker.json"));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toMatch(/unsupported.*sticker/i);
  });

  test("status webhook (delivered) -> no messages, one status", () => {
    const { messages, statuses } = parseWebhookPayload(fixture("status-delivered.json"));
    expect(messages).toEqual([]);
    expect(statuses).toEqual([{ messageId: "wamid.HBgLMTU1NTAwMDIyMjIVAgARGBI1QjJGRTU3NzUxNjBDQjI4RTcA", status: "delivered", timestamp: 1750000050000, recipientId: "15550002222", error: undefined }]);
  });

  test("status webhook (failed) -> carries the error code/message", () => {
    const { statuses } = parseWebhookPayload(fixture("status-failed.json"));
    expect(statuses[0]?.error).toEqual({ code: 131026, message: "Message undeliverable" });
  });

  test("batched entries with multiple messages + a status in a separate entry", () => {
    const { messages, statuses } = parseWebhookPayload(fixture("batched-multiple-messages.json"));
    expect(messages.map((m) => m.text)).toEqual(["hi", "are you open today?"]);
    expect(statuses).toHaveLength(1);
  });

  test("status-only payload -> zero messages, no crash", () => {
    const { messages, statuses } = parseWebhookPayload(fixture("status-only-no-messages.json"));
    expect(messages).toEqual([]);
    expect(statuses).toHaveLength(1);
  });

  test("every fixture's parsed messages satisfy InboundMessageSchema", () => {
    for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
      const { messages } = parseWebhookPayload(fixture(file));
      for (const m of messages) {
        const r = InboundMessageSchema.safeParse(m);
        expect(r.success, `${file}: ${r.success ? "" : JSON.stringify(r.error?.issues)}`).toBe(true);
      }
    }
  });
});

describe("parseWebhookPayload — never throws on garbage input", () => {
  const garbage: unknown[] = [
    null,
    undefined,
    "",
    "not json at all",
    42,
    true,
    [],
    {},
    { object: "page" }, // wrong webhook type entirely
    { entry: "not an array" },
    { entry: [null, 42, "x", []] },
    { entry: [{ changes: "nope" }] },
    { entry: [{ changes: [{ field: "messages", value: "not an object" }] }] },
    { entry: [{ changes: [{ field: "messages", value: { messages: "nope", statuses: 42 } }] }] },
    { entry: [{ changes: [{ field: "messages", value: { messages: [null, 1, "x", [], { type: 123 }] } }] }] },
    { entry: [{ changes: [{ field: "messages", value: { messages: [{ id: 5, from: 5, type: "text", text: "not-an-object" }] } }] }] },
    { entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: 1, status: "bogus", recipient_id: 1 }] } }] }] },
    { entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x", from: "y", type: "interactive", interactive: "nope" }] } }] }] },
    { entry: Array.from({ length: 50 }, () => ({ changes: [{ field: "messages", value: { messages: [{ id: "x", from: "y", type: "text" }] } }] })) },
    JSON.parse('{"entry": [{"changes": [{"field": "messages", "value": {"messages": [{"id": "x", "from": "y", "type": "text", "text": {"body": null}}]}}]}]}'),
  ];

  test.each(garbage.map((g, i) => [i, g] as const))("case %i does not throw", (_i, input) => {
    expect(() => parseWebhookPayload(input)).not.toThrow();
  });

  test("random deeply-nested structures never throw", () => {
    function randomJson(depth: number): unknown {
      if (depth <= 0) return Math.random() > 0.5 ? "leaf" : Math.floor(Math.random() * 100);
      const kind = Math.floor(Math.random() * 5);
      if (kind === 0) return null;
      if (kind === 1) return Array.from({ length: 3 }, () => randomJson(depth - 1));
      if (kind === 2) return { entry: randomJson(depth - 1), changes: randomJson(depth - 1), value: randomJson(depth - 1), messages: randomJson(depth - 1), statuses: randomJson(depth - 1) };
      if (kind === 3) return Math.random();
      return "x".repeat(Math.floor(Math.random() * 20));
    }
    for (let i = 0; i < 200; i++) {
      expect(() => parseWebhookPayload(randomJson(5))).not.toThrow();
    }
  });
});
