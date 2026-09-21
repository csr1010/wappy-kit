import { describe, expect, test } from "vitest";
import { runChannelConformance } from "@wappy/testkit";
import { createWhatsAppChannel } from "./channel.js";
import { createMemorySeenStore } from "./seen-store.js";
import { createSessionWindowTracker } from "./session-window.js";
import type { StatusEvent } from "./parser.js";

const textWebhook = (id: string, from = "15550002222") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { messages: [{ id, from, timestamp: "1750000000", type: "text", text: { body: "hi" } }] } }] }],
});
const statusOnlyWebhook = { object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { statuses: [{ id: "s1", status: "sent", timestamp: "1", recipient_id: "x" }] } }] }] };

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("createWhatsAppChannel — conformance (B6)", () => {
  test("passes runChannelConformance", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.1" }] }) });
    const violations = await runChannelConformance(channel, {
      rawWithMessage: textWebhook("wamid.conformance"),
      rawStatusOnly: statusOnlyWebhook,
      to: "15550002222",
      message: { text: "hello" },
    });
    expect(violations).toEqual([]);
  });
});

describe("createWhatsAppChannel — reliability", () => {
  test("duplicate webhook delivery (same message.id) is deduped, single message emitted", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t" });
    const first = await channel.receive(textWebhook("wamid.dup"));
    const second = await channel.receive(textWebhook("wamid.dup"));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("status-only payloads never produce a message and don't crash", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t" });
    await expect(channel.receive(statusOnlyWebhook)).resolves.toEqual([]);
    await expect(channel.receive(null)).resolves.toEqual([]);
    await expect(channel.receive("garbage")).resolves.toEqual([]);
  });

  test("status webhooks are routed to onStatus, not returned as messages", async () => {
    const events: StatusEvent[] = [];
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", onStatus: (e) => events.push(e) });
    await channel.receive(statusOnlyWebhook);
    expect(events).toEqual([{ messageId: "s1", status: "sent", timestamp: 1000, recipientId: "x", error: undefined }]);
  });

  test("a fresh inbound message opens the session window for that contact", async () => {
    const sessionWindow = createSessionWindowTracker();
    const clockNow = 1_000_000;
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", sessionWindow, now: () => clockNow });
    expect(sessionWindow.windowOpen("15550002222", clockNow)).toBe(false);
    await channel.receive(textWebhook("wamid.window1"));
    expect(sessionWindow.windowOpen("15550002222", clockNow)).toBe(true);
  });

  test("an injected seenStore is honored (custom TTL)", async () => {
    let now = 0;
    const seenStore = createMemorySeenStore({ ttlMs: 100 });
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", seenStore, now: () => now });
    expect(await channel.receive(textWebhook("wamid.ttl"))).toHaveLength(1);
    now = 50;
    expect(await channel.receive(textWebhook("wamid.ttl"))).toHaveLength(0);
    now = 200;
    expect(await channel.receive(textWebhook("wamid.ttl"))).toHaveLength(1);
  });

  test("send() posts text and returns sent + messageId on success", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.out1" }] }) });
    expect(await channel.send("15550002222", { text: "hello there" })).toEqual({ status: "sent", messageId: "wamid.out1" });
  });

  test("send() maps a Meta error response to a failed DeliveryResult with a reason", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", fetchImpl: fakeFetch(400, { error: { code: 131026, message: "Message undeliverable" } }) });
    const result = await channel.send("15550002222", { text: "hi" });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/131026/);
  });

  test("send() maps a network error to a failed DeliveryResult", async () => {
    const channel = createWhatsAppChannel({
      phoneNumberId: "pn1",
      accessToken: "t",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    const result = await channel.send("15550002222", { text: "hi" });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/ECONNRESET/);
  });
});
