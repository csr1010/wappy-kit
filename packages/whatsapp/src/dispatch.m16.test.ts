import { describe, expect, test } from "vitest";
import type { InboundMessage, MessageChannel } from "@wappy_ai/core";
import { createWhatsAppChannel } from "./channel.js";
import { dispatchInbound } from "./dispatch.js";

const payload = (id: string) => ({
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, messages: [{ id, from: "c1", timestamp: "1700000000", type: "text", text: { body: "hi" } }] } }] }],
});

function recordingFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ success: true, messages: [{ id: "w1" }] }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("M16: dispatchInbound — receive, read + typing, handle (for hosts with their own HTTP server)", () => {
  test("sends read + typing for each fresh message before handing it over, and skips Meta's retries", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const channel = createWhatsAppChannel({ phoneNumberId: "111", accessToken: "t", fetchImpl });
    const handled: string[] = [];
    const handle = async (m: InboundMessage) => { handled.push(m.id); };

    expect((await dispatchInbound({ channel, payload: payload("m1"), handle })).map((m) => m.id)).toEqual(["m1"]);
    await dispatchInbound({ channel, payload: payload("m1"), handle }); // retry
    await new Promise((r) => setTimeout(r, 0));

    expect(handled).toEqual(["m1"]);
    const typing = calls.filter((c) => c.body.status === "read");
    expect(typing).toHaveLength(1);
    expect(typing[0].body).toMatchObject({ message_id: "m1", typing_indicator: { type: "text" } });
  });

  test("a failing handler or typing call is reported, never thrown", async () => {
    const errors: unknown[] = [];
    const fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
    const channel = createWhatsAppChannel({ phoneNumberId: "111", accessToken: "t", fetchImpl });
    await dispatchInbound({ channel, payload: payload("m2"), handle: async () => { throw new Error("boom"); }, onError: (e) => errors.push(e) });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => String(e))).toEqual(expect.arrayContaining([expect.stringContaining("boom")]));
  });

  test("a channel without typing support just handles", async () => {
    const plain: MessageChannel = { name: "x", receive: async () => [{ id: "a", contactId: "c", channel: "x", timestamp: 0 }], send: async () => ({ status: "sent" }) };
    const handled: string[] = [];
    await dispatchInbound({ channel: plain, payload: {}, handle: async (m) => { handled.push(m.id); } });
    expect(handled).toEqual(["a"]);
  });
});
