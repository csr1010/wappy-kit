import { describe, expect, test, vi } from "vitest";
import { assertSafeUrl, fetchSafely, SsrfBlockedError } from "./ssrf.js";

describe("assertSafeUrl — scheme validation", () => {
  test("http and https are allowed by default", async () => {
    await expect(assertSafeUrl("https://93.184.216.34/", { resolveHostname: async () => ["93.184.216.34"] })).resolves.toBeInstanceOf(URL);
  });

  test("a non-http(s) scheme is rejected by default", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("ftp://example.com/x")).rejects.toThrow(SsrfBlockedError);
  });

  test("a custom allowedSchemes list can explicitly opt in", async () => {
    await expect(assertSafeUrl("ftp://example.com/x", { allowedSchemes: ["ftp:"], resolveHostname: async () => ["93.184.216.34"] })).resolves.toBeInstanceOf(URL);
  });

  test("an unparseable URL is rejected loudly, not a generic crash", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow(SsrfBlockedError);
  });
});

describe("assertSafeUrl — literal IP addresses (SSRF matrix)", () => {
  test("127.0.0.1 (loopback) is blocked", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow(SsrfBlockedError);
  });

  test("169.254.169.254 (cloud metadata / link-local) is blocked", async () => {
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(SsrfBlockedError);
  });

  test("[::1] (IPv6 loopback) is blocked", async () => {
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow(SsrfBlockedError);
  });

  test("10.x/172.16.x/192.168.x (RFC1918 private ranges) are blocked", async () => {
    await expect(assertSafeUrl("http://10.0.0.5/")).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("http://172.16.0.5/")).rejects.toThrow(SsrfBlockedError);
    await expect(assertSafeUrl("http://192.168.1.5/")).rejects.toThrow(SsrfBlockedError);
  });

  test("0.0.0.0 is blocked", async () => {
    await expect(assertSafeUrl("http://0.0.0.0/")).rejects.toThrow(SsrfBlockedError);
  });

  test("an IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is blocked — a classic filter-bypass form", async () => {
    await expect(assertSafeUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(SsrfBlockedError);
  });

  test("a genuine public IP literal is allowed", async () => {
    await expect(assertSafeUrl("http://93.184.216.34/")).resolves.toBeInstanceOf(URL);
  });
});

describe("assertSafeUrl — DNS names are actually resolved, not just string-matched", () => {
  test("a hostname resolving (via injected resolver) to a private address is blocked — DNS-rebind style", async () => {
    await expect(assertSafeUrl("http://evil.example.com/", { resolveHostname: async () => ["10.0.0.1"] })).rejects.toThrow(SsrfBlockedError);
  });

  test("a hostname resolving to a public address is allowed", async () => {
    await expect(assertSafeUrl("https://api.example.com/", { resolveHostname: async () => ["93.184.216.34"] })).resolves.toBeInstanceOf(URL);
  });

  test("a hostname with MULTIPLE resolved addresses is blocked if ANY one of them is private", async () => {
    await expect(assertSafeUrl("https://mixed.example.com/", { resolveHostname: async () => ["93.184.216.34", "127.0.0.1"] })).rejects.toThrow(SsrfBlockedError);
  });

  test("a hostname that fails to resolve to any address is blocked, not silently passed through", async () => {
    await expect(assertSafeUrl("https://nowhere.example.com/", { resolveHostname: async () => [] })).rejects.toThrow(SsrfBlockedError);
  });
});

describe("assertSafeUrl — explicit opt-in for private networks", () => {
  test("allowPrivateNetworks: true bypasses the address check entirely (e.g. local dev against a self-hosted mock)", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:4010/", { allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  });

  test("allowPrivateNetworks: true still enforces the scheme allow-list", async () => {
    await expect(assertSafeUrl("file:///etc/passwd", { allowPrivateNetworks: true })).rejects.toThrow(SsrfBlockedError);
  });
});

describe("fetchSafely — redirects are re-validated on every hop", () => {
  function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
    return { status, headers: new Headers(headers) } as Response;
  }

  test("a direct (non-redirecting) safe fetch returns the response after one call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200));
    const response = await fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a redirect to a PUBLIC url is followed and re-validated", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: "https://other.example.com/y" }))
      .mockResolvedValueOnce(fakeResponse(200));
    const response = await fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("a redirect to a PRIVATE IP is blocked, not silently followed — the classic SSRF-via-redirect bypass", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeResponse(302, { location: "http://169.254.169.254/latest/meta-data/" }));
    await expect(fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl })).rejects.toThrow(SsrfBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never actually called fetch on the unsafe hop
  });

  test("a redirect chain longer than maxRedirects is rejected rather than followed forever", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(302, { location: "https://api.example.com/next" }));
    await expect(fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl, maxRedirects: 2 })).rejects.toThrow(SsrfBlockedError);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3); // initial + 2 redirects, then stop
  });

  test("a relative Location header is resolved against the current URL before re-validation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: "/y" }))
      .mockResolvedValueOnce(fakeResponse(200));
    const response = await fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls[1]?.[0]?.toString()).toBe("https://api.example.com/y");
  });
});

describe("assertSafeUrl — the real default DNS resolver (no injected resolveHostname)", () => {
  test("'localhost' (real DNS, no injected resolver) resolves to loopback and is blocked", async () => {
    await expect(assertSafeUrl("http://localhost/")).rejects.toThrow(SsrfBlockedError);
  });
});

describe("assertSafeUrl — a resolved address that isn't a parseable IP at all is treated as unsafe, not a crash", () => {
  test("a custom resolveHostname returning garbage (not an IP) fails safe rather than throwing an unhandled error", async () => {
    await expect(assertSafeUrl("https://weird.example.com/", { resolveHostname: async () => ["not-an-ip-address"] })).rejects.toThrow(SsrfBlockedError);
  });
});
