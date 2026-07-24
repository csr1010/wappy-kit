import type { ToolResult } from "@wappy/core";
import type { GeneratedTool } from "./operations.js";
import type { ResolvedAuth } from "./auth.js";
import { applyAuth } from "./auth.js";
import { fetchSafely, type SafeFetchOptions } from "./ssrf.js";

export interface ExecutorOptions {
  /** The API's base URL (typically `document.servers[0].url`) — joined with the tool's `path`. */
  baseUrl: string;
  auth: ResolvedAuth;
  /** Reads a secret by env-var name at CALL time. Defaults to `process.env`. */
  envReader?: (name: string) => string | undefined;
  /** Aborts the request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Response bytes are capped (stream-abort, not buffered fully first) — a truncated body is
   * reported via `data`/`error`, never silently handed to the model as if complete. Default 2 MB. */
  maxResponseBytes?: number;
  /** Extra attempts for GET/HEAD ONLY (idempotent) on a network error or 5xx response. Default 2. */
  maxRetries?: number;
  /** Delay before each retry, doubled per attempt. Default 200ms — tests can set this to 0. */
  retryDelayMs?: number;
  /** Passed through to `fetchSafely` for every real request this tool makes. */
  ssrf?: SafeFetchOptions;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONTROL_CHAR_PATTERN = /[\r\n\0]/;

function safeHeaderOrCookieValue(name: string, value: string): string {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`Value for "${name}" contains invalid control characters (possible header/cookie injection).`);
  }
  return value;
}

interface SplitArgs {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  header: Record<string, unknown>;
  cookie: Record<string, unknown>;
  body: unknown;
  hasBody: boolean;
}

/** Splits the model's flat call args by `"x-wappy-in"` (set by operations.ts's parameter
 * flattening) — the property NAMES iterated here come from the spec-derived schema (trusted), so an
 * attacker-controlled arg value (e.g. a `__proto__` key nested inside a body object) is never used as
 * an assignment target here; it only ever flows into `JSON.stringify(body)` as ordinary payload data. */
function splitArgs(tool: GeneratedTool, args: Record<string, unknown>): SplitArgs {
  const props = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: SplitArgs = { path: {}, query: {}, header: {}, cookie: {}, body: undefined, hasBody: false };
  for (const [name, propSchema] of Object.entries(props)) {
    if (!(name in args)) continue;
    const location = propSchema["x-wappy-in"];
    const value = args[name];
    if (location === "path") out.path[name] = value;
    else if (location === "query") out.query[name] = value;
    else if (location === "header") out.header[name] = value;
    else if (location === "cookie") out.cookie[name] = value;
    else if (location === "body") {
      out.body = value;
      out.hasBody = true;
    }
  }
  return out;
}

/** Substitutes `{name}` path template segments with `encodeURIComponent`-escaped values — a `/` in a
 * value becomes a literal `%2F`, so it can never split into an extra path segment (path-injection
 * safe: a value like `"../../etc/passwd"` stays confined to the ONE segment it was substituted into). */
function buildPath(pathTemplate: string, pathParams: Record<string, unknown>): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (!(name in pathParams)) throw new Error(`Missing required path parameter: "${name}"`);
    return encodeURIComponent(String(pathParams[name]));
  });
}

/** Joins `baseUrl`'s own path (e.g. an API version prefix like `/v1`, common in `servers[].url`)
 * with the operation's path — NOT `new URL(operationPath, baseUrl)` alone, since an operation path
 * always starts with `/`, and per WHATWG URL resolution an absolute path REPLACES the base's path
 * rather than appending to it, which would silently drop `baseUrl`'s prefix on every real call.
 * Known, accepted limitation: a `baseUrl` carrying its OWN query string or fragment (not a
 * documented/supported OpenAPI Server Object pattern — no real spec does this) is dropped the same
 * way, since `fullPath` is still resolved as an absolute path against `base`. */
function buildUrl(baseUrl: string, pathTemplate: string, pathParams: Record<string, unknown>, query: Record<string, unknown>): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const fullPath = `${basePath}${buildPath(pathTemplate, pathParams)}`;
  const url = new URL(fullPath, base);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(name, String(value));
  }
  return url;
}

function buildHeaders(
  headerParams: Record<string, unknown>,
  cookieParams: Record<string, unknown>,
  authFragment: { headers?: Record<string, string>; cookies?: Record<string, string> },
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(headerParams)) {
    if (value === undefined) continue;
    headers.set(name, safeHeaderOrCookieValue(name, String(value)));
  }
  if (authFragment.headers) {
    for (const [name, value] of Object.entries(authFragment.headers)) headers.set(name, safeHeaderOrCookieValue(name, value));
  }
  const cookiePairs: string[] = [];
  for (const [name, value] of Object.entries(cookieParams)) {
    if (value === undefined) continue;
    cookiePairs.push(`${name}=${encodeURIComponent(safeHeaderOrCookieValue(name, String(value)))}`);
  }
  if (authFragment.cookies) {
    for (const [name, value] of Object.entries(authFragment.cookies)) cookiePairs.push(`${name}=${encodeURIComponent(safeHeaderOrCookieValue(name, value))}`);
  }
  if (cookiePairs.length > 0) headers.set("Cookie", cookiePairs.join("; "));
  return headers;
}

function isJsonContentType(contentType: string | null): boolean {
  return !!contentType && /application\/(?:[^+]*\+)?json/i.test(contentType);
}

function isTextLikeContentType(contentType: string | null): boolean {
  return !!contentType && (/^text\//i.test(contentType) || /^application\/(xml|x-www-form-urlencoded)/i.test(contentType));
}

interface CappedBody {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<CappedBody> {
  if (!response.body) {
    const text = await response.text();
    return { text, truncated: false, totalBytes: Buffer.byteLength(text) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    // ReadableStreamReadResult<Uint8Array> guarantees `value` is present whenever `done` is false
    // (only a `done: true` result may omit it) — no separate falsy-value guard needed.
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      // The outer buildExecutor() try/catch is the safety net for a rejected cancel() too, so no
      // separate swallow is needed here.
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buffer.toString("utf8"), truncated, totalBytes: total };
}

function isRetryableMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/**
 * Builds the bound `execute(args)` function for one generated tool (§8 T7.5): flattens args back
 * into path/query/header/cookie/body per their `"x-wappy-in"` tags, safely encodes the URL (path
 * params can never split into an extra segment) and headers/cookies (control chars rejected —
 * defense against CRLF header/cookie injection), injects auth (T7.4) at call time, fetches through
 * the SSRF guard (T7.8, redirects re-validated), retries only idempotent GET/HEAD on a network error
 * or 5xx, and caps the response body by streaming (never buffers an unbounded response first). Always
 * resolves to a normalized `ToolResult` — a tool failure (4xx/5xx/timeout/network/invalid JSON/huge
 * body) is reported as `{ok: false, error}`, never a thrown exception into the caller.
 */
export function buildExecutor(tool: GeneratedTool, opts: ExecutorOptions): (args: unknown) => Promise<ToolResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const envReader = opts.envReader ?? ((name: string) => process.env[name]);

  return async function execute(rawArgs: unknown): Promise<ToolResult> {
    try {
      const args = (rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {}) as Record<string, unknown>;
      const split = splitArgs(tool, args);
      const url = buildUrl(opts.baseUrl, tool.path, split.path, split.query);
      const authFragment = applyAuth(opts.auth, envReader);
      if (authFragment.query) for (const [k, v] of Object.entries(authFragment.query)) url.searchParams.set(k, v);
      const headers = buildHeaders(split.header, split.cookie, authFragment);

      let body: string | undefined;
      if (split.hasBody) {
        body = JSON.stringify(split.body);
        if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      }

      const method = tool.method.toUpperCase();
      const attemptsAllowed = isRetryableMethod(method) ? maxRetries + 1 : 1;

      let lastError: string | undefined;
      for (let attempt = 0; attempt < attemptsAllowed; attempt++) {
        if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));

        let response: Response;
        try {
          response = await fetchSafely(url.toString(), {
            ...opts.ssrf,
            init: { method, headers, body, signal: AbortSignal.timeout(timeoutMs) },
          });
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          continue; // network/timeout/SSRF error -> retry if allowed, else fall through to final error
        }

        if (response.status >= 500 && attempt < attemptsAllowed - 1) {
          lastError = `HTTP ${response.status}`;
          continue;
        }

        const capped = await readBodyCapped(response, maxResponseBytes);
        if (capped.truncated) {
          return { toolName: tool.name, ok: false, error: `Response exceeded the ${maxResponseBytes}-byte cap and was truncated.` };
        }

        if (!response.ok) {
          return { toolName: tool.name, ok: false, error: `HTTP ${response.status}: ${capped.text.slice(0, 500) || response.statusText}` };
        }

        const contentType = response.headers.get("content-type");
        if (capped.text.length === 0) {
          return { toolName: tool.name, ok: true, data: { status: response.status, body: null } };
        }
        if (isJsonContentType(contentType)) {
          try {
            return { toolName: tool.name, ok: true, data: { status: response.status, body: JSON.parse(capped.text) } };
          } catch {
            return { toolName: tool.name, ok: false, error: `Response declared Content-Type: ${contentType} but body was not valid JSON.` };
          }
        }
        if (isTextLikeContentType(contentType) || contentType === null) {
          return { toolName: tool.name, ok: true, data: { status: response.status, body: capped.text } };
        }
        return { toolName: tool.name, ok: true, data: { status: response.status, contentType, sizeBytes: capped.totalBytes, note: "binary content omitted" } };
      }

      // lastError is always set before the loop can exit here: every path that falls through to the
      // next iteration (a caught network/SSRF error, or a retryable 5xx) sets it first.
      return { toolName: tool.name, ok: false, error: lastError! };
    } catch (e) {
      // Absolute last resort — e.g. a missing required path param, a missing auth secret, or an
      // encoding error thrown before any network call. Still never escapes as a thrown exception.
      return { toolName: tool.name, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
