import { describe, expect, test, vi } from "vitest";
import { markReadAndTyping } from "./presence.js";

const BASE = { graphApiBaseUrl: "https://graph.facebook.com/v21.0", phoneNumberId: "123", accessToken: "tok", messageId: "wamid.ABC" };

describe("markReadAndTyping — the exact request Meta's docs specify", () => {
  test("POSTs the combined mark-as-read + typing_indicator body to the right endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const result = await markReadAndTyping({ ...BASE, fetchImpl });
    expect(result).toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/123/messages");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init!.body as string)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
      typing_indicator: { type: "text" },
    });
  });

  test("a non-2xx response is a clean failure, not a throw", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 }));
    const result = await markReadAndTyping({ ...BASE, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("400");
  });

  test("a network error is caught, not thrown", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await markReadAndTyping({ ...BASE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "ECONNRESET" });
  });

  test("a non-Error throw (e.g. a plain string) is stringified, not left as [object Object]", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "raw string failure";
    });
    const result = await markReadAndTyping({ ...BASE, fetchImpl });
    expect(result).toEqual({ ok: false, error: "raw string failure" });
  });

  test("a slow response is aborted at timeoutMs, not hung forever", async () => {
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const result = await markReadAndTyping({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 });
    expect(result.ok).toBe(false);
  });
});
