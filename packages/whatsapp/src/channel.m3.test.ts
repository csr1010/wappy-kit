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

  test("a retried status delivery (same messageId+status) is deduped, fires onStatus once", async () => {
    const events: StatusEvent[] = [];
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", onStatus: (e) => events.push(e) });
    await channel.receive(statusOnlyWebhook);
    await channel.receive(statusOnlyWebhook); // Meta retries the same webhook delivery
    expect(events).toHaveLength(1);
  });

  test("concurrent duplicate deliveries of the same status only fire onStatus once", async () => {
    const events: StatusEvent[] = [];
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", onStatus: (e) => events.push(e) });
    await Promise.all([channel.receive(statusOnlyWebhook), channel.receive(statusOnlyWebhook), channel.receive(statusOnlyWebhook)]);
    expect(events).toHaveLength(1);
  });

  test("a throwing onStatus leaves the status retryable, not permanently lost", async () => {
    const events: StatusEvent[] = [];
    let shouldThrow = true;
    const channel = createWhatsAppChannel({
      phoneNumberId: "pn1",
      accessToken: "t",
      onStatus: (e) => {
        if (shouldThrow) throw new Error("transient DB error");
        events.push(e);
      },
    });

    await expect(channel.receive(statusOnlyWebhook)).rejects.toThrow("transient DB error");
    expect(events).toEqual([]);

    // Meta retries the same webhook delivery; this time the handler succeeds.
    shouldThrow = false;
    await channel.receive(statusOnlyWebhook);
    expect(events).toHaveLength(1);
  });

  test("distinct statuses for the same message (sent -> delivered -> read) all fire, not deduped against each other", async () => {
    const events: StatusEvent[] = [];
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", onStatus: (e) => events.push(e) });
    const webhookWith = (status: string) => ({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.same", status, timestamp: "1", recipient_id: "x" }] } }] }] });
    await channel.receive(webhookWith("sent"));
    await channel.receive(webhookWith("delivered"));
    await channel.receive(webhookWith("read"));
    expect(events.map((e) => e.status)).toEqual(["sent", "delivered", "read"]);
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

  // M4 note (--allow-test-change): these send() tests originally assumed M3's placeholder
  // text-only, no-window-guard send(). M4 adds the mandatory 24h session-window guard (§6.2) and
  // real SmartMessage rendering (§6.1), which M3 explicitly deferred (see channel.ts's M3 doc
  // comment / PROGRESS.md). Updated to open the window first (as a real caller would, having
  // received an inbound message) and, for the media-only case, to assert the now-correct rendered
  // payload instead of the old always-type-text placeholder. A fast no-op-sleep clock keeps the
  // now-retrying error-path tests instant instead of paying real backoff delays.
  const instantClock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
  const withOpenWindow = () => {
    const sessionWindow = createSessionWindowTracker();
    sessionWindow.recordInbound("15550002222", 0); // must agree with the channel's own `now`/`clock` (also 0) so the window reads as open
    return sessionWindow;
  };

  test("send() posts text and returns sent + messageId on success", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", now: () => 0, sessionWindow: withOpenWindow(), fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.out1" }] }) });
    expect(await channel.send("15550002222", { text: "hello there" })).toEqual({ status: "sent", messageId: "wamid.out1" });
  });

  test("send() with only media (no text) renders a real media message, not a text placeholder", async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out2" }] }), { status: 200 });
    }) as typeof fetch;
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", now: () => 0, sessionWindow: withOpenWindow(), fetchImpl });
    await channel.send("15550002222", { media: { kind: "image", url: "https://example.com/a.png" } });
    expect(sentBody).toMatchObject({ type: "image", image: { link: "https://example.com/a.png" } });
  });

  test("send() maps a Meta error response to a failed DeliveryResult with a reason", async () => {
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", now: () => 0, sessionWindow: withOpenWindow(), fetchImpl: fakeFetch(400, { error: { code: 131026, message: "Message undeliverable" } }) });
    const result = await channel.send("15550002222", { text: "hi" });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/131026/);
  });

  test("send() handles a non-JSON error response body gracefully", async () => {
    const channel = createWhatsAppChannel({
      phoneNumberId: "pn1",
      accessToken: "t",
      sessionWindow: withOpenWindow(),
      clock: instantClock,
      fetchImpl: (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as typeof fetch,
    });
    const result = await channel.send("15550002222", { text: "hi" });
    expect(result).toEqual({ status: "failed", reason: "http 502" });
  });

  test("send() maps a network error to a failed DeliveryResult", async () => {
    const channel = createWhatsAppChannel({
      phoneNumberId: "pn1",
      accessToken: "t",
      sessionWindow: withOpenWindow(),
      clock: instantClock,
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    });
    const result = await channel.send("15550002222", { text: "hi" });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/ECONNRESET/);
  });
});
