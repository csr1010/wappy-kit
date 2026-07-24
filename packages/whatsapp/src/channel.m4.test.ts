import { describe, expect, test } from "vitest";
import { createWhatsAppChannel } from "./channel.js";

const textWebhook = (id: string, from = "15550002222") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { messages: [{ id, from, timestamp: "1750000000", type: "text", text: { body: "hi" } }] } }] }],
});

describe("createWhatsAppChannel — clock consistency (M4 review fix)", () => {
  test("a caller supplying only `clock` (no `now`) still sees receive()'s window recording and send()'s window check agree", async () => {
    let t = 1000;
    const clock = { now: () => t, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
    const fetchImpl = (async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out1" }] }), { status: 200 })) as typeof fetch;
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", clock, fetchImpl });

    await channel.receive(textWebhook("wamid.in1"));
    t += 1000; // advance a little, still well within the 24h window under the SAME clock
    const result = await channel.send("15550002222", { text: "reply" });
    expect(result).toEqual({ status: "sent", messageId: "wamid.out1" });
  });

  test("a caller supplying only `now` (legacy option) also keeps receive() and send() on the same clock", async () => {
    let t = 1000;
    const fetchImpl = (async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out1" }] }), { status: 200 })) as typeof fetch;
    const channel = createWhatsAppChannel({ phoneNumberId: "pn1", accessToken: "t", now: () => t, fetchImpl });

    await channel.receive(textWebhook("wamid.in2"));
    t += 1000;
    const result = await channel.send("15550002222", { text: "reply" });
    expect(result).toEqual({ status: "sent", messageId: "wamid.out1" });
  });
});
