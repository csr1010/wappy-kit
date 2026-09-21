import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { downloadWhatsAppMedia } from "./media.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

interface ServerOpts {
  /** Receives this server's own base URL, so the metadata response can point `url` back at /file. */
  metaBody: (base: string) => unknown;
  metaStatus?: number;
  fileBytes?: Uint8Array;
  fileMime?: string;
  fileStatus?: number;
  onFileRequest?: () => void;
}

/** One local server that plays both Graph API hops: GET /media/:id (metadata) and GET /file (the temp download URL). */
async function startServer(opts: ServerOpts): Promise<{ base: string; mediaBase: string }> {
  let base = "";
  server = createServer((req, res) => {
    if (req.url?.startsWith("/media/")) {
      res.statusCode = opts.metaStatus ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(opts.metaBody(base)));
      return;
    }
    opts.onFileRequest?.();
    res.statusCode = opts.fileStatus ?? 200;
    res.setHeader("content-type", opts.fileMime ?? "application/octet-stream");
    res.end(Buffer.from(opts.fileBytes ?? new Uint8Array()));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  return { base, mediaBase: `${base}/media` };
}

describe("downloadWhatsAppMedia — defaults and edge cases", () => {
  test("defaults graphApiBaseUrl to the real Cloud API host when not given", async () => {
    let requestedUrl = "";
    await downloadWhatsAppMedia({
      mediaId: "123",
      accessToken: "t",
      maxBytes: 1000,
      fetchImpl: (async (input: string | URL | Request) => {
        if (!requestedUrl) requestedUrl = String(input); // capture only the first (metadata) hop
        return new Response(JSON.stringify({ url: "http://x/file", mime_type: "text/plain", file_size: 1 }));
      }) as typeof fetch,
    });
    expect(requestedUrl).toBe("https://graph.facebook.com/v21.0/123");
  });

  test("defaults mimeType to application/octet-stream when the metadata omits mime_type", async () => {
    const { mediaBase } = await startServer({ metaBody: (base) => ({ url: `${base}/file` }), fileBytes: new Uint8Array([1]) });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1000 });
    expect(result).toEqual({ ok: true, media: { bytes: new Uint8Array([1]), mimeType: "application/octet-stream" } });
  });

  test("metadata missing a url maps to http_error", async () => {
    const { mediaBase } = await startServer({ metaBody: () => ({ mime_type: "image/jpeg", file_size: 1 }) });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1000 });
    expect(result).toEqual({ ok: false, error: { kind: "http_error", status: 502 } });
  });
});

describe("downloadWhatsAppMedia", () => {
  test("happy path: resolves the media id then downloads the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { mediaBase } = await startServer({
      metaBody: (base) => ({ url: `${base}/file`, mime_type: "image/jpeg", file_size: 4 }),
      fileMime: "image/jpeg",
      fileBytes: bytes,
    });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1_000_000 });
    expect(result).toEqual({ ok: true, media: { bytes, mimeType: "image/jpeg" } });
  });

  test("declared file_size over the cap aborts before the second hop", async () => {
    let secondHopCalled = false;
    const { mediaBase } = await startServer({
      metaBody: (base) => ({ url: `${base}/file`, mime_type: "video/mp4", file_size: 50_000_000 }),
      onFileRequest: () => {
        secondHopCalled = true;
      },
    });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1_000_000 });
    expect(result).toEqual({ ok: false, error: { kind: "too_large", limitBytes: 1_000_000 } });
    expect(secondHopCalled).toBe(false);
  });

  test("actual bytes exceeding the cap abort mid-stream even when file_size was absent", async () => {
    const bigBytes = new Uint8Array(2_000_000).fill(7);
    const { mediaBase } = await startServer({
      metaBody: (base) => ({ url: `${base}/file`, mime_type: "video/mp4" }), // no file_size declared
      fileBytes: bigBytes,
    });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1_000_000 });
    expect(result).toEqual({ ok: false, error: { kind: "too_large", limitBytes: 1_000_000 } });
  });

  test("a disallowed mime type is rejected before downloading", async () => {
    let secondHopCalled = false;
    const { mediaBase } = await startServer({
      metaBody: (base) => ({ url: `${base}/file`, mime_type: "application/x-msdownload", file_size: 10 }),
      onFileRequest: () => {
        secondHopCalled = true;
      },
    });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1_000_000, allowedMimeTypes: ["image/jpeg", "image/png"] });
    expect(result).toEqual({ ok: false, error: { kind: "mime_not_allowed", mimeType: "application/x-msdownload" } });
    expect(secondHopCalled).toBe(false);
  });

  test("a non-2xx from the metadata hop maps to http_error", async () => {
    const { mediaBase } = await startServer({ metaBody: () => ({ error: "nope" }), metaStatus: 404 });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1000 });
    expect(result).toEqual({ ok: false, error: { kind: "http_error", status: 404 } });
  });

  test("a non-2xx from the file download hop maps to http_error", async () => {
    const { mediaBase } = await startServer({
      metaBody: (base) => ({ url: `${base}/file`, mime_type: "image/jpeg", file_size: 10 }),
      fileStatus: 500,
    });
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: mediaBase, maxBytes: 1000 });
    expect(result).toEqual({ ok: false, error: { kind: "http_error", status: 500 } });
  });

  test("a network error resolving the media id maps to network_error", async () => {
    const result = await downloadWhatsAppMedia({
      mediaId: "123",
      accessToken: "t",
      graphApiBaseUrl: "http://127.0.0.1:1/media",
      maxBytes: 1000,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(result).toEqual({ ok: false, error: { kind: "network_error", message: "connection refused" } });
  });

  test("a network error downloading the (successfully resolved) file maps to network_error", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media/")) return new Response(JSON.stringify({ url: "http://unreachable.invalid/file", mime_type: "image/jpeg", file_size: 10 }), { status: 200 });
      throw new Error("connection reset");
    }) as typeof fetch;
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: "http://x/media", maxBytes: 1000, fetchImpl });
    expect(result).toEqual({ ok: false, error: { kind: "network_error", message: "connection reset" } });
  });

  test("a response without a streamable body falls back to a single-buffer read, still capped", async () => {
    // Simulates an environment where the response has no ReadableStream body (body: null).
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media/")) return new Response(JSON.stringify({ url: "http://x/file", mime_type: "text/plain", file_size: 2 }));
      const r = new Response("ok");
      Object.defineProperty(r, "body", { value: null });
      return r;
    }) as typeof fetch;
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: "http://x/media", maxBytes: 1000, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.media.bytes)).toBe("ok");
  });

  test("a response without a streamable body still enforces the byte cap", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media/")) return new Response(JSON.stringify({ url: "http://x/file", mime_type: "text/plain" }));
      const r = new Response("this body is longer than the cap");
      Object.defineProperty(r, "body", { value: null });
      return r;
    }) as typeof fetch;
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: "http://x/media", maxBytes: 5, fetchImpl });
    expect(result).toEqual({ ok: false, error: { kind: "too_large", limitBytes: 5 } });
  });

  test("a non-streamable response rejects on a declared Content-Length over the cap WITHOUT buffering the body", async () => {
    let bodyWasRead = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media/")) return new Response(JSON.stringify({ url: "http://x/file", mime_type: "video/mp4" }));
      const r = new Response("x".repeat(10), { headers: { "content-length": "50000000" } });
      Object.defineProperty(r, "body", { value: null });
      const originalArrayBuffer = r.arrayBuffer.bind(r);
      r.arrayBuffer = async () => {
        bodyWasRead = true;
        return originalArrayBuffer();
      };
      return r;
    }) as typeof fetch;
    const result = await downloadWhatsAppMedia({ mediaId: "123", accessToken: "t", graphApiBaseUrl: "http://x/media", maxBytes: 1_000_000, fetchImpl });
    expect(result).toEqual({ ok: false, error: { kind: "too_large", limitBytes: 1_000_000 } });
    expect(bodyWasRead).toBe(false);
  });
});
