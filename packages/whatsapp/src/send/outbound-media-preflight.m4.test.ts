import { describe, expect, test } from "vitest";
import { preflightOutboundMedia } from "./outbound-media-preflight.js";

function fetchWithContentLength(length: number | undefined): typeof fetch {
  return (async () => new Response(null, { headers: length !== undefined ? { "content-length": String(length) } : {} })) as typeof fetch;
}

describe("preflightOutboundMedia", () => {
  test("an unknown media kind is rejected immediately, no network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null);
    }) as typeof fetch;
    const error = await preflightOutboundMedia({ kind: "sticker" as never, url: "https://x.com/a" }, { fetchImpl });
    expect(error).toEqual({ kind: "unknown_kind", mediaKind: "sticker" });
    expect(called).toBe(false);
  });

  test("a known disallowed mime type is rejected immediately, no network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null);
    }) as typeof fetch;
    const error = await preflightOutboundMedia({ kind: "image", url: "https://x.com/a", mimeType: "image/gif" }, { fetchImpl });
    expect(error?.kind).toBe("mime_not_allowed");
    expect(called).toBe(false);
  });

  test("no mimeType supplied -> mime check is skipped (we genuinely don't know it)", async () => {
    const error = await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" }, { fetchImpl: fetchWithContentLength(100) });
    expect(error).toBeUndefined();
  });

  test("a HEAD response's Content-Length over the limit is rejected", async () => {
    const error = await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" }, { fetchImpl: fetchWithContentLength(50_000_000) });
    expect(error).toEqual({ kind: "too_large", limitBytes: expect.any(Number) });
  });

  test("a HEAD response's Content-Length within the limit passes", async () => {
    const error = await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" }, { fetchImpl: fetchWithContentLength(1000) });
    expect(error).toBeUndefined();
  });

  test("uses the global fetch when no fetchImpl override is given", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { headers: { "content-length": "100" } })) as typeof fetch;
    try {
      expect(await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" })).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("no url -> nothing to check, passes (Meta will still validate at send time)", async () => {
    expect(await preflightOutboundMedia({ kind: "image" })).toBeUndefined();
  });

  test("a missing Content-Length header is not treated as an error (best-effort only)", async () => {
    const error = await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" }, { fetchImpl: fetchWithContentLength(undefined) });
    expect(error).toBeUndefined();
  });

  test("a HEAD request failure (network error) is not treated as an error (best-effort only)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await preflightOutboundMedia({ kind: "image", url: "https://x.com/a" }, { fetchImpl })).toBeUndefined();
  });
});
