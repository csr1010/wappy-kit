import { afterEach, describe, expect, test, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Agent, DeliveryResult, InboundMessage, MessageChannel } from "@wappy/core";
import { signWebhook } from "@wappy/testkit";
import { createWebhookServer } from "./webhook-server.js";

const VERIFY_TOKEN = "verify-me";
const APP_SECRET = "shh-app-secret";

function fakeChannel(receiveImpl?: (payload: unknown) => Promise<InboundMessage[]>): MessageChannel {
  return {
    name: "whatsapp",
    receive: receiveImpl ?? (async () => []),
    send: vi.fn(async (): Promise<DeliveryResult> => ({ status: "sent" })),
  };
}
function fakeAgent(handleImpl?: (m: InboundMessage) => Promise<DeliveryResult>): Agent {
  return { handle: handleImpl ?? (async () => ({ status: "sent" })) };
}
function inbound(id: string): InboundMessage {
  return { id, contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0 };
}

const servers: import("node:http").Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function boot(opts: Partial<Parameters<typeof createWebhookServer>[0]> = {}) {
  const server = createWebhookServer({ verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, channel: fakeChannel(), agent: fakeAgent(), ...opts });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("GET — Meta's webhook verification handshake", () => {
  test("correct mode/token echoes hub.challenge with 200", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=xyz123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xyz123");
  });

  test("wrong verify_token is rejected with 403, challenge never echoed", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=xyz123`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("xyz123");
  });

  test("missing hub.mode is rejected", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=xyz123`);
    expect(res.status).toBe(403);
  });

  test("missing hub.challenge (mode/token otherwise correct) is rejected, not treated as an empty-string challenge", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`);
    expect(res.status).toBe(403);
  });

  test("missing hub.verify_token (mode/challenge otherwise present) is rejected", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.challenge=xyz123`);
    expect(res.status).toBe(403);
  });
});

describe("POST — signature verification (§6.2/§11: mandatory, checked on the raw body before parsing)", () => {
  test("a validly signed, well-formed payload is accepted (200) and dispatched", async () => {
    const receive = vi.fn(async () => [inbound("m1")]);
    const handle = vi.fn(async (): Promise<DeliveryResult> => ({ status: "sent" }));
    const { base } = await boot({ channel: fakeChannel(receive), agent: fakeAgent(handle) });
    const body = JSON.stringify({ entry: [] });
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledWith(inbound("m1")));
    expect(receive).toHaveBeenCalledWith({ entry: [] });
  });

  test("missing signature header is rejected with 401; channel.receive is never called", async () => {
    const receive = vi.fn(async () => []);
    const { base } = await boot({ channel: fakeChannel(receive) });
    const res = await fetch(`${base}/webhook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
  });

  test("a forged/mismatched signature is rejected with 401", async () => {
    const receive = vi.fn(async () => []);
    const { base } = await boot({ channel: fakeChannel(receive) });
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook("{}", "wrong-secret") }, body: "{}" });
    expect(res.status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
  });

  test("a valid signature over a DIFFERENT body than what's actually sent is rejected (proves it checks the real raw body)", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook('{"other":"body"}', APP_SECRET) }, body: '{"real":"body"}' });
    expect(res.status).toBe(401);
  });
});

describe("POST — responds before processing finishes (ack fast, per WhatsApp's own guidance)", () => {
  test("200 arrives even while agent.handle is still pending", async () => {
    let resolveHandle!: () => void;
    const handle = vi.fn(() => new Promise<DeliveryResult>((r) => (resolveHandle = () => r({ status: "sent" }))));
    const { base } = await boot({ channel: fakeChannel(async () => [inbound("m1")]), agent: fakeAgent(handle) });
    const body = "{}";
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(200); // returned without waiting for resolveHandle()
    expect(handle).toHaveBeenCalled();
    resolveHandle();
  });

  test("multiple messages from one payload are each dispatched to agent.handle", async () => {
    const handle = vi.fn(async (): Promise<DeliveryResult> => ({ status: "sent" }));
    const { base } = await boot({ channel: fakeChannel(async () => [inbound("a"), inbound("b")]), agent: fakeAgent(handle) });
    const body = "{}";
    await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
  });
});

describe("POST — typing indicator (§6.1 presence): fired for a WhatsAppMessageChannel, skipped otherwise", () => {
  test("a channel with markReadAndTyping gets it called with the message id, before/alongside agent.handle", async () => {
    const markReadAndTyping = vi.fn(async () => ({ ok: true }) as const);
    const channel = { ...fakeChannel(async () => [inbound("m1")]), markReadAndTyping };
    const { base } = await boot({ channel });
    const body = "{}";
    await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    await vi.waitFor(() => expect(markReadAndTyping).toHaveBeenCalledWith("m1"));
  });

  test("a plain MessageChannel without markReadAndTyping is never called for it, and still processes normally", async () => {
    const handle = vi.fn(async (): Promise<DeliveryResult> => ({ status: "sent" }));
    const { base } = await boot({ channel: fakeChannel(async () => [inbound("m1")]), agent: fakeAgent(handle) });
    const body = "{}";
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(handle).toHaveBeenCalled());
  });

  test("a failing markReadAndTyping is reported via onError but does not block agent.handle from running", async () => {
    const onError = vi.fn();
    const markReadAndTyping = vi.fn(async () => ({ ok: false, error: "rate limited" }) as const);
    const handle = vi.fn(async (): Promise<DeliveryResult> => ({ status: "sent" }));
    const channel = { ...fakeChannel(async () => [inbound("m1")]), markReadAndTyping };
    const { base } = await boot({ channel, agent: fakeAgent(handle), onError });
    const body = "{}";
    await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    await vi.waitFor(() => expect(handle).toHaveBeenCalled());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("rate limited") })));
  });
});

describe("robustness", () => {
  test("malformed JSON (but correctly signed) is rejected with 400, not a crash", async () => {
    const { base } = await boot();
    const body = "not json{{{";
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(400);
  });

  test("a body over maxBodyBytes is rejected with 413 instead of buffered", async () => {
    const { base } = await boot({ maxBodyBytes: 10 });
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook("x".repeat(1000), APP_SECRET) }, body: "x".repeat(1000) });
    expect(res.status).toBe(413);
  });

  test("further chunks arriving AFTER the 413 was already sent are silently ignored, not double-resolved", async () => {
    const { base } = await boot({ maxBodyBytes: 5 });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(20))); // already over the limit
        await new Promise((r) => setTimeout(r, 20)); // let the server's response land first
        controller.enqueue(new TextEncoder().encode("more-after-too-large"));
        controller.close();
      },
    });
    const res = await fetch(`${base}/webhook`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("wrong path is 404; wrong method on the real path is 405", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/not-the-webhook`)).status).toBe(404);
    expect((await fetch(`${base}/webhook`, { method: "PUT" })).status).toBe(405);
  });

  test("path is configurable", async () => {
    const { base } = await boot({ path: "/hooks/wa" });
    const res = await fetch(`${base}/hooks/wa?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ok`);
    expect(res.status).toBe(200);
  });

  test("agent.handle throwing is caught by onError, not a crash — and 200 was already sent", async () => {
    const onError = vi.fn();
    const handle = vi.fn(async () => {
      throw new Error("boom");
    });
    const { base } = await boot({ channel: fakeChannel(async () => [inbound("m1")]), agent: fakeAgent(handle), onError });
    const body = "{}";
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  test("channel.receive throwing is caught by onError, not a crash — 200 was already sent", async () => {
    const onError = vi.fn();
    const receive = vi.fn(async () => {
      throw new Error("parse blew up");
    });
    const { base } = await boot({ channel: fakeChannel(receive), onError });
    const body = "{}";
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook(body, APP_SECRET) }, body });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });

  test("empty POST body (still correctly \"signed\" over empty string) is treated as {}", async () => {
    const receive = vi.fn(async () => []);
    const { base } = await boot({ channel: fakeChannel(receive) });
    const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "x-hub-signature-256": signWebhook("", APP_SECRET) } });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledWith({}));
  });
});
