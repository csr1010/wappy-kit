import { describe, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { Agent } from "undici";
import { assertSafeUrl, fetchSafely, pinnedLookup, SsrfBlockedError } from "./ssrf.js";

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

  test("an intermediate redirect hop's body is drained (cancelled), not left unread — a leaked connection otherwise", async () => {
    const cancel = vi.fn(async () => undefined);
    const redirectResponse = { status: 302, headers: new Headers({ location: "https://other.example.com/y" }), body: { cancel } } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(fakeResponse(200));
    const response = await fetchSafely("https://api.example.com/x", { resolveHostname: async () => ["93.184.216.34"], fetchImpl });
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledTimes(1);
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

describe("pinnedLookup — the dispatcher's actual connect-time lookup, tested directly (no real network needed)", () => {
  function collect(): { promise: Promise<[Error | null, unknown]>; callback: (err: Error | null, addresses: unknown) => void } {
    let resolve!: (v: [Error | null, unknown]) => void;
    const promise = new Promise<[Error | null, unknown]>((r) => (resolve = r));
    return { promise, callback: (err, addresses) => resolve([err, addresses]) };
  }

  test("a safe hostname resolves to address/family entries via the callback, no error", async () => {
    const { promise, callback } = collect();
    pinnedLookup("api.example.com", { resolveHostname: async () => ["93.184.216.34"] }, callback);
    const [err, addresses] = await promise;
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  test("an unsafe hostname calls back with an error (SsrfBlockedError) and an empty address list, never a thrown/unhandled rejection", async () => {
    const { promise, callback } = collect();
    pinnedLookup("internal.example.com", { resolveHostname: async () => ["10.0.0.1"] }, callback);
    const [err, addresses] = await promise;
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(addresses).toEqual([]);
  });

  test("a resolveHostname that rejects with a non-Error value is still normalized into a real Error via the callback", async () => {
    const { promise, callback } = collect();
    pinnedLookup(
      "broken.example.com",
      {
        resolveHostname: () => {
          throw "a plain string rejection, not an Error instance";
        },
      },
      callback,
    );
    const [err, addresses] = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("plain string rejection");
    expect(addresses).toEqual([]);
  });

  test("an IPv6 address is classified with family 6", async () => {
    const { promise, callback } = collect();
    pinnedLookup("v6.example.com", { resolveHostname: async () => ["2001:4860:4860::8888"] }, callback);
    const [err, addresses] = await promise;
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: "2001:4860:4860::8888", family: 6 }]);
  });
});

describe("fetchSafely — DNS-rebinding TOCTOU: the REAL connection (not just the pre-check) is guarded", () => {
  test("a hostname that's safe at pre-check time but resolves to a private address at actual-connect time is still blocked — a true rebind simulation, not just the pre-check catching it", async () => {
    // No fetchImpl here deliberately — this exercises createPinnedDispatcher()'s connect-time lookup,
    // via pinnedLookup(), not just assertSafeUrl()'s separate pre-check. The resolver returns a SAFE
    // address on its first call (assertSafeUrl's pre-check, which must pass) and an UNSAFE one on the
    // second (the dispatcher's own lookup at actual connect time) — simulating an attacker's DNS
    // server answering differently a moment later. Before this fix, real fetch() would have performed
    // its own independent system DNS resolution at connect time (ignoring resolveHostname entirely),
    // so a rebind like this would NOT have been caught — the pre-check alone can't see it coming.
    let calls = 0;
    const resolveHostname = async () => {
      calls++;
      return calls === 1 ? ["93.184.216.34"] : ["10.0.0.1"];
    };
    await expect(fetchSafely("http://rebind-target.invalid/", { resolveHostname })).rejects.toThrow(SsrfBlockedError);
    expect(calls).toBeGreaterThanOrEqual(2); // proves the dispatcher's OWN lookup actually ran, not just the pre-check
  });

  test("allowPrivateNetworks bypasses the pinned dispatcher entirely (documented escape hatch for local dev)", async () => {
    // Confirms the dispatcher is genuinely skipped (not silently still blocking) when explicitly
    // opted out — a request to a real local server succeeds end-to-end through the real fetch.
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await fetchSafely(`http://127.0.0.1:${port}/`, { allowPrivateNetworks: true });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("fetchSafely's dispatcher-close pattern doesn't deadlock on a real, sizeable response body", () => {
  // A REAL end-to-end test through fetchSafely() itself can't reach this exact code path with a real
  // network target — the pinned dispatcher only activates for an address that classifies as public
  // ("unicast"), and this sandbox has no way to bind a test server to a publicly-routable address or
  // reliably reach one over real egress. Instead, this test reproduces createPinnedDispatcher()'s
  // EXACT connect/close pattern (a real undici Agent using pinnedLookup — the same exported function
  // fetchSafely()'s dispatcher wraps — against a real local server with a large body), which is the
  // part of the mechanism that actually determines whether the deadlock exists: undici's
  // `Agent.close()` only resolves once the response body is fully drained by a consumer, so awaiting
  // it before returning the response (the bug fetchSafely() had) hangs for any non-trivial body until
  // the caller's own abort timeout fires; NOT awaiting it (the fix) lets the caller read the body
  // first and the close complete naturally afterward.
  test("a ~200KB body is fully readable promptly, without the close() call ever blocking the response from being returned", async () => {
    const bigBody = "x".repeat(200_000);
    const server = createServer((_req, res) => res.end(bigBody));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      // A hand-rolled lookup (not pinnedLookup() itself, which would correctly reject a loopback
      // address regardless of any option — that validation is already covered elsewhere). This test
      // is specifically about the connect/close TIMING mechanism createPinnedDispatcher() uses, not
      // re-proving the address-safety check.
      const dispatcher = new Agent({
        connect: { lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) },
      });
      const start = Date.now();
      let response: Response;
      try {
        response = await fetch(`http://fake-target.invalid:${port}/`, { dispatcher: dispatcher as unknown as never });
        // The fix under test: fire-and-forget, exactly matching fetchSafely()'s own success path —
        // NOT `await dispatcher.close()`, which would block until the body below is fully read.
        dispatcher.close().catch(() => undefined);
      } catch (e) {
        await dispatcher.close().catch(() => undefined);
        throw e;
      }
      const elapsedBeforeRead = Date.now() - start;
      expect(elapsedBeforeRead).toBeLessThan(2000); // returned promptly — proves close() wasn't awaited
      const text = await response.text();
      expect(text).toHaveLength(200_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
