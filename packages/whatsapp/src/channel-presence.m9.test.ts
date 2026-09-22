import { describe, expect, test, vi } from "vitest";
import { createWhatsAppChannel } from "./channel.js";

describe("createWhatsAppChannel — markReadAndTyping (§6.1 presence, T9.7)", () => {
  test("uses the channel's own phoneNumberId/accessToken/graphApiBaseUrl/fetchImpl — no separate config needed", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const channel = createWhatsAppChannel({ phoneNumberId: "999", accessToken: "secret-tok", graphApiBaseUrl: "https://example.test/v1", fetchImpl });

    const result = await channel.markReadAndTyping("wamid.XYZ");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/999/messages");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer secret-tok");
    expect(JSON.parse(init!.body as string).message_id).toBe("wamid.XYZ");
  });
});
