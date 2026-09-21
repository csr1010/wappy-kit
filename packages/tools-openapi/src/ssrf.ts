import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

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

/**
 * Validates a URL is safe to fetch (§8 T7.8, §10 "SSRF guard") before the spec-URL fetch or any
 * `servers[]` base-URL call: rejects non-allowed schemes, and — unless `allowPrivateNetworks` is set
 * — rejects any hostname whose resolved address(es) are loopback/link-local/private/reserved/etc. A
 * literal IP in the URL is checked directly; a DNS name is actually RESOLVED and every returned
 * address checked, closing the DNS-rebinding gap a naive hostname-string check would miss. Callers
 * MUST call this again on every redirect hop's `Location` before following it — a URL that started
 * safe can redirect somewhere unsafe.
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
  const addresses = ipaddr.isValid(hostname) ? [hostname] : await (opts.resolveHostname ?? defaultResolveHostname)(hostname);

  if (addresses.length === 0) {
    throw new SsrfBlockedError(`Could not resolve hostname "${hostname}" to any address: ${rawUrl}`);
  }

  for (const address of addresses) {
    if (!isSafeAddress(address)) {
      throw new SsrfBlockedError(`URL "${rawUrl}" resolves to a disallowed address (${address}) — loopback/link-local/private/reserved ranges are blocked by default.`);
    }
  }

  return url;
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
 * `Location` is re-validated with `assertSafeUrl` before being followed, using manual (not
 * fetch's automatic) redirect handling so no hop is ever followed unchecked.
 */
export async function fetchSafely(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertSafeUrl(currentUrl, opts);
    const response = await doFetch(validated, { ...opts.init, redirect: "manual" });
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get("location");
    if (isRedirect && location) {
      currentUrl = new URL(location, validated).toString();
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError(`Too many redirects (> ${maxRedirects}) while fetching ${rawUrl}`);
}
