import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";
// Node's global `fetch` is itself powered by an internally-bundled undici, and accepts a `dispatcher`
// option that MUST be interop-compatible with that internal copy's Dispatcher/Agent shape — cross-
// major-version instances are NOT interchangeable (confirmed empirically: undici 8.x's Agent used as
// a dispatcher for a Node runtime whose bundled undici is 6.x throws a cryptic internal
// "invalid onRequestStart method" error, not a clear one). `node:undici` (which would let us borrow
// the runtime's OWN copy directly, guaranteeing compatibility) isn't available as an importable
// built-in on every Node version this project might run on. Pinning this dependency to `^6`, matching
// current Node LTS's bundled major, is a known, accepted v0.1 limitation — a future Node LTS bumping
// its bundled undici to a new major would require bumping this dependency to match.
import { Agent } from "undici";

export class SsrfBlockedError extends Error {}

export interface SsrfGuardOptions {
  /** Explicit opt-in to skip the address check entirely (e.g. local dev against a self-hosted mock
   * API). Default false — deny by default. The scheme allow-list is still enforced either way. */
  allowPrivateNetworks?: boolean;
  /** Allowed URL schemes. Default `["http:", "https:"]`. */
  allowedSchemes?: string[];
  /** Injectable for tests — defaults to a real DNS lookup. Returns every address a hostname
   * resolves to, since a multi-answer DNS response is unsafe if ANY answer is private. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_ALLOWED_SCHEMES = ["http:", "https:"];

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function isSafeAddress(address: string): boolean {
  try {
    // process() also normalizes IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) into plain IPv4 first — a
    // classic bypass form for a check that only inspects the IPv6 representation.
    const parsed = ipaddr.process(address);
    // Allow-list, not a blocklist: only "unicast" (ordinary public, routable) passes. Everything else
    // — loopback, linkLocal, private, uniqueLocal, reserved, benchmarking, multicast, unspecified,
    // amt, teredo, 6to4, carrierGradeNat, ... — is blocked, including ranges not explicitly named
    // here, since a blocklist would need updating every time a new special-use range is defined.
    return parsed.range() === "unicast";
  } catch {
    return false; // unparseable address -> treat as unsafe
  }
}

/** Resolves `hostname` (or returns it directly if it's already a literal IP) and throws unless EVERY
 * returned address is safe — shared by `assertSafeUrl`'s fail-fast pre-check and the pinned-lookup
 * dispatcher below, so both enforce the exact same "unsafe if ANY answer is private" policy. */
async function resolveSafeAddresses(hostname: string, opts: SsrfGuardOptions): Promise<string[]> {
  const addresses = ipaddr.isValid(hostname) ? [hostname] : await (opts.resolveHostname ?? defaultResolveHostname)(hostname);
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`Could not resolve hostname "${hostname}" to any address.`);
  }
  for (const address of addresses) {
    if (!isSafeAddress(address)) {
      throw new SsrfBlockedError(`Hostname "${hostname}" resolves to a disallowed address (${address}) — loopback/link-local/private/reserved ranges are blocked by default.`);
    }
  }
  return addresses;
}

/**
 * Validates a URL is safe to fetch (§8 T7.8, §10 "SSRF guard") before the spec-URL fetch or any
 * `servers[]` base-URL call: rejects non-allowed schemes, and — unless `allowPrivateNetworks` is set
 * — rejects any hostname whose resolved address(es) are loopback/link-local/private/reserved/etc. This
 * is a fast, clear-error PRE-check; it does NOT by itself close a DNS-rebinding race (the hostname
 * could resolve differently a moment later, when the real connection is made) — `fetchSafely()` closes
 * that gap for real by pinning the connection to these exact validated addresses via a custom
 * connect-time DNS lookup, not by re-trusting a second, separate resolution. Callers that need the
 * TOCTOU-safe guarantee should go through `fetchSafely()`, not call this directly and then fetch.
 */
export async function assertSafeUrl(rawUrl: string, opts: SsrfGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }

  const allowedSchemes = opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  if (!allowedSchemes.includes(url.protocol)) {
    throw new SsrfBlockedError(`URL scheme "${url.protocol}" is not allowed (allowed: ${allowedSchemes.join(", ")}): ${rawUrl}`);
  }

  if (opts.allowPrivateNetworks) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // URL wraps an IPv6 literal host in [...]
  await resolveSafeAddresses(hostname, opts);
  return url;
}

interface DnsLookupCallback {
  (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]): void;
}

/** The actual connect-time lookup logic, factored out from `createPinnedDispatcher()` so it's
 * directly unit-testable (as a plain async function with a callback) without needing a real network
 * connection to exercise its success/failure paths. Exported for that reason only — not meant as a
 * standalone public API. */
export function pinnedLookup(hostname: string, opts: SsrfGuardOptions, callback: DnsLookupCallback): void {
  resolveSafeAddresses(hostname, opts)
    .then((addresses) => callback(null, addresses.map((address) => ({ address, family: ipaddr.process(address).kind() === "ipv6" ? 6 : 4 }))))
    .catch((e: unknown) => callback(e instanceof Error ? e : new Error(String(e)), []));
}

/**
 * An undici `Agent` whose `connect.lookup` re-resolves (and re-validates) the hostname at the exact
 * moment a connection is actually made, handing undici the validated address(es) directly instead of
 * letting it perform its own independent, later DNS resolution — this is what actually closes the
 * DNS-rebinding TOCTOU gap `assertSafeUrl` alone cannot: there is no separate "check, then trust"
 * step for an attacker's DNS server to race, because resolution and validation happen together, right
 * at connection time, using the SAME lookup this dispatcher performs.
 */
function createPinnedDispatcher(opts: SsrfGuardOptions): Agent {
  return new Agent({
    connect: {
      lookup: (hostname: string, _options: unknown, callback: DnsLookupCallback) => pinnedLookup(hostname, opts, callback),
    },
  });
}

export interface SafeFetchOptions extends SsrfGuardOptions {
  /** Max redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number;
  init?: RequestInit;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetches a URL with the SSRF guard applied to the initial URL AND to every redirect hop (§8 T7.8,
 * "redirects re-validated") — a target that starts safe can still redirect somewhere unsafe, so each
 * `Location` is re-validated with `assertSafeUrl` before being followed, using manual (not fetch's
 * automatic) redirect handling so no hop is ever followed unchecked. When using the real default
 * `fetch` (no injected `fetchImpl`) and `allowPrivateNetworks` isn't set, every hop's ACTUAL
 * connection also goes through `createPinnedDispatcher()`'s connect-time lookup — not just
 * `assertSafeUrl`'s separate pre-check — closing the DNS-rebinding TOCTOU gap a pre-check-then-fetch
 * sequence alone can't close. A caller-injected `fetchImpl` (used throughout this package's own
 * tests) can't accept a real undici dispatcher, so the pinning step is skipped for it; that's fine
 * since a test double doesn't perform a real DNS-resolving connection to race in the first place.
 */
export async function fetchSafely(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  const usePinnedDispatcher = !opts.fetchImpl && !opts.allowPrivateNetworks;
  const dispatcher = usePinnedDispatcher ? createPinnedDispatcher(opts) : undefined;
  let currentUrl = rawUrl;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const validated = await assertSafeUrl(currentUrl, opts);
      const init: RequestInit = { ...opts.init, redirect: "manual" };
      if (dispatcher) (init as RequestInit & { dispatcher: Agent }).dispatcher = dispatcher;
      let response: Response;
      try {
        response = await doFetch(validated, init);
      } catch (e) {
        // The Fetch spec wraps any network-level failure — including our own pinned-lookup rejection
        // — in a generic TypeError("fetch failed") with the real cause attached via `.cause`. Unwrap
        // an SsrfBlockedError cause so callers see the actual reason, not just "fetch failed".
        if (e instanceof Error && e.cause instanceof SsrfBlockedError) throw e.cause;
        throw e;
      }
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (isRedirect && location) {
        currentUrl = new URL(location, validated).toString();
        continue;
      }
      return response;
    }
    throw new SsrfBlockedError(`Too many redirects (> ${maxRedirects}) while fetching ${rawUrl}`);
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}
