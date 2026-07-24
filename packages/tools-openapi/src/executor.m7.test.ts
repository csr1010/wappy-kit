import { describe, expect, test, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { GeneratedTool } from "./operations.js";
import type { ResolvedAuth } from "./auth.js";
import { buildExecutor } from "./executor.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

type Handler = (req: CapturedRequest) => { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number };

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const captured: CapturedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const result = handler(captured);
      if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));
      res.statusCode = result.status ?? 200;
      for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
      res.end(result.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function tool(overrides: Partial<GeneratedTool> = {}): GeneratedTool {
  return {
    name: "getThing",
    description: "x",
    method: "get",
    path: "/things/{id}",
    operation: { responses: {} },
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", "x-wappy-in": "path" },
      },
      required: ["id"],
    },
    ...overrides,
  };
}

const NO_AUTH: ResolvedAuth = { kind: "none" };
let activeServer: TestServer | undefined;

afterEach(async () => {
  if (activeServer) await activeServer.close();
  activeServer = undefined;
});

describe("buildExecutor — happy path: path/query/header/body mapping", () => {
  test("a path parameter is substituted into the URL", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "abc123" });
    expect(activeServer.requests[0]?.path).toBe("/things/abc123");
  });

  test("a baseUrl carrying a path prefix (e.g. an API version, the common real-world shape) is preserved, not replaced", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: `${activeServer.url}/v1`, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "abc123" });
    expect(activeServer.requests[0]?.path).toBe("/v1/things/abc123");
  });

  test("a baseUrl path prefix WITH a trailing slash is also preserved correctly (no double slash)", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: `${activeServer.url}/v1/`, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "abc123" });
    expect(activeServer.requests[0]?.path).toBe("/v1/things/abc123");
  });

  test("a multi-segment baseUrl path prefix is preserved", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: `${activeServer.url}/admin/api/2024-01`, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "abc123" });
    expect(activeServer.requests[0]?.path).toBe("/admin/api/2024-01/things/abc123");
  });

  test("a query parameter is appended as a URL search param", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/things", parameters: { type: "object", properties: { limit: { type: "integer", "x-wappy-in": "query" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ limit: 10 });
    expect(activeServer.requests[0]?.path).toBe("/things?limit=10");
  });

  test("a header parameter is sent as a real HTTP header", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { "X-Trace-Id": { type: "string", "x-wappy-in": "header" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ "X-Trace-Id": "trace-1" });
    expect(activeServer.requests[0]?.headers["x-trace-id"]).toBe("trace-1");
  });

  test("a body arg is JSON-stringified and sent with Content-Type: application/json", async () => {
    activeServer = await startServer(() => ({ status: 201, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ method: "post", path: "/x", parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ body: { name: "widget" } });
    expect(activeServer.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(activeServer.requests[0]!.body)).toEqual({ name: "widget" });
  });

  test("a successful JSON response is returned as ok:true with the parsed body under data", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result).toMatchObject({ toolName: "getThing", ok: true, data: { status: 200, body: { hello: "world" } } });
  });

  test("a non-JSON text response is returned as text under data.body", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "text/plain" }, body: "plain text reply" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result).toMatchObject({ ok: true, data: { status: 200, body: "plain text reply" } });
  });

  test("a binary response (unrecognized content-type) is summarized, not returned raw", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "image/png" }, body: "not-real-png-bytes" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).note).toBe("binary content omitted");
  });
});

describe("buildExecutor — auth injection", () => {
  test("apiKey-in-header auth is actually sent on the real request", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "apiKey", in: "header", paramName: "X-Api-Key", envVar: "TEST_KEY" },
      envReader: (k) => (k === "TEST_KEY" ? "secret-value" : undefined),
      ssrf: { allowPrivateNetworks: true },
    });
    await execute({ id: "x" });
    expect(activeServer.requests[0]?.headers["x-api-key"]).toBe("secret-value");
  });

  test("bearer auth sends a real Authorization header", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "bearer", envVar: "TOK" },
      envReader: (k) => (k === "TOK" ? "abc" : undefined),
      ssrf: { allowPrivateNetworks: true },
    });
    await execute({ id: "x" });
    expect(activeServer.requests[0]?.headers.authorization).toBe("Bearer abc");
  });

  test("a missing auth secret produces a failed ToolResult, not a thrown exception", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "bearer", envVar: "MISSING" },
      envReader: () => undefined,
      ssrf: { allowPrivateNetworks: true },
    });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("MISSING");
    expect(activeServer.requests).toHaveLength(0); // never even made the request
  });
});

describe("buildExecutor — error normalization (4xx/5xx/timeout/invalid JSON)", () => {
  test("a 404 is reported as ok:false with the status in the error message", async () => {
    activeServer = await startServer(() => ({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not found" }) }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, maxRetries: 0 });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });

  test("a 500 on a non-idempotent method (POST) is reported directly, no retry", async () => {
    activeServer = await startServer(() => ({ status: 500, body: "server error" }));
    const t = tool({ method: "post", path: "/x", parameters: { type: "object", properties: {} } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, retryDelayMs: 0 });
    const result = await execute({});
    expect(result.ok).toBe(false);
    expect(activeServer.requests).toHaveLength(1);
  });

  test("a request that never resolves is aborted by the timeout and reported as a failed result", async () => {
    activeServer = await startServer(() => ({ status: 200, delayMs: 5000, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, timeoutMs: 50, maxRetries: 0 });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
  }, 10_000);

  test("a declared JSON content-type with an invalid JSON body is reported as a failed result", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{not valid json" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON/i);
  });

  test("a response exceeding maxResponseBytes is truncated and reported as a failed result, not silently handed to the model", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ big: "x".repeat(10_000) }) }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, maxResponseBytes: 100 });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeded|truncat/i);
  });
});

describe("buildExecutor — retries only idempotent GET/HEAD", () => {
  test("a GET that fails with 5xx twice then succeeds is retried and returns the eventual success", async () => {
    let calls = 0;
    activeServer = await startServer(() => {
      calls++;
      if (calls < 3) return { status: 503, body: "unavailable" };
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
    });
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, maxRetries: 2, retryDelayMs: 1 });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("a GET that always 5xxs exhausts retries and reports a failed result", async () => {
    activeServer = await startServer(() => ({ status: 503, body: "unavailable" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, maxRetries: 2, retryDelayMs: 1 });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(activeServer.requests).toHaveLength(3); // 1 initial + 2 retries
  });

  test("a POST that 5xxs is NEVER retried, even once", async () => {
    activeServer = await startServer(() => ({ status: 503, body: "unavailable" }));
    const t = tool({ method: "post", path: "/x", parameters: { type: "object", properties: {} } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true }, maxRetries: 5, retryDelayMs: 1 });
    await execute({});
    expect(activeServer.requests).toHaveLength(1);
  });
});

describe("buildExecutor — security: path-injection and header/cookie-injection safety", () => {
  test("a path param value containing '../' and a literal '/' is confined to one path segment, not escaping it", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "../../etc/passwd" });
    const requestedPath = activeServer.requests[0]!.path;
    // The literal slashes from the injected value must be percent-encoded (%2F), not present as raw "/".
    expect(requestedPath.startsWith("/things/")).toBe(true);
    expect(requestedPath.slice("/things/".length)).not.toContain("/");
  });

  test("an already-percent-encoded slash in a path param value is double-encoded, not decoded into a real separator", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ id: "a%2Fb" });
    const requestedPath = activeServer.requests[0]!.path;
    expect(requestedPath.slice("/things/".length)).not.toContain("/");
  });

  test("a header value containing CRLF is rejected before any request is sent (header injection)", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { "X-Trace": { type: "string", "x-wappy-in": "header" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ "X-Trace": "value\r\nX-Injected: evil" });
    expect(result.ok).toBe(false);
    expect(activeServer.requests).toHaveLength(0);
  });
});

describe("buildExecutor — security: __proto__ in body args never pollutes Object.prototype", () => {
  test("a body containing a __proto__ key is sent as ordinary JSON data, without polluting the global Object prototype", async () => {
    activeServer = await startServer((req) => ({ status: 200, headers: { "content-type": "application/json" }, body: req.body }));
    const t = tool({ method: "post", path: "/x", parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ body: JSON.parse('{"__proto__": {"polluted": true}}') });
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(activeServer.requests[0]!.body)).toHaveProperty("__proto__");
  });
});

describe("buildExecutor — never throws", () => {
  test("a missing required path param produces a failed ToolResult, not a thrown exception", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("id");
  });

  test("undefined args (no args at all) still produce a normalized failed result for a tool requiring a path param", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "{}" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute(undefined);
    expect(result.ok).toBe(false);
  });
});

describe("buildExecutor — cookie params and cookie auth", () => {
  test("a cookie-location parameter is sent as a real Cookie header", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { session: { type: "string", "x-wappy-in": "cookie" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ session: "abc123" });
    expect(activeServer.requests[0]?.headers.cookie).toContain("session=abc123");
  });

  test("apiKey-in-cookie auth is sent as a real Cookie header", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "apiKey", in: "cookie", paramName: "session_id", envVar: "SID" },
      envReader: (k) => (k === "SID" ? "xyz" : undefined),
      ssrf: { allowPrivateNetworks: true },
    });
    await execute({ id: "x" });
    expect(activeServer.requests[0]?.headers.cookie).toContain("session_id=xyz");
  });

  test("apiKey-in-query auth is appended to the request URL", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "apiKey", in: "query", paramName: "api_key", envVar: "AK" },
      envReader: (k) => (k === "AK" ? "qk" : undefined),
      ssrf: { allowPrivateNetworks: true },
    });
    await execute({ id: "x" });
    expect(activeServer.requests[0]?.path).toContain("api_key=qk");
  });
});

describe("buildExecutor — explicit undefined values are skipped, not sent as literal 'undefined'", () => {
  test("an explicit undefined query value is omitted from the URL", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { limit: { type: "integer", "x-wappy-in": "query" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ limit: undefined });
    expect(activeServer.requests[0]?.path).toBe("/x");
  });

  test("an explicit undefined header value is omitted, not sent as the string 'undefined'", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { "X-Trace": { type: "string", "x-wappy-in": "header" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ "X-Trace": undefined });
    expect(activeServer.requests[0]?.headers["x-trace"]).toBeUndefined();
  });
});

describe("buildExecutor — response body edge cases", () => {
  test("a response with no body (e.g. 204 No Content) is reported as ok:true with a null body", async () => {
    activeServer = await startServer(() => ({ status: 204 }));
    const t = tool({ method: "delete" });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result).toMatchObject({ ok: true, data: { status: 204, body: null } });
  });

  test("a HEAD response (no body at all) is reported as ok:true with a null body", async () => {
    activeServer = await startServer(() => ({ status: 200 }));
    const t = tool({ method: "head" });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(true);
  });

  test("a response with no Content-Type header at all is treated as text, not binary", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "hello" }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result).toMatchObject({ ok: true, data: { body: "hello" } });
  });
});

describe("buildExecutor — a header param already setting Content-Type is not overridden by the body default", () => {
  test("an explicit Content-Type header param is preserved when a body is also sent", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({
      method: "post",
      path: "/x",
      parameters: { type: "object", properties: { "Content-Type": { type: "string", "x-wappy-in": "header" }, body: { type: "object", "x-wappy-in": "body" } } },
    });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ "Content-Type": "application/json; charset=utf-8", body: { x: 1 } });
    expect(activeServer.requests[0]?.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});

describe("buildExecutor — body serialization respects the operation's declared media type", () => {
  test("a body with no declared x-wappy-media-type defaults to JSON (backward compatible)", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ method: "post", path: "/x", parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ body: { name: "widget" } });
    expect(activeServer.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(activeServer.requests[0]!.body)).toEqual({ name: "widget" });
  });

  test("a body declaring application/x-www-form-urlencoded is sent as a real URL-encoded form, not JSON", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({
      method: "post",
      path: "/x",
      parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body", "x-wappy-media-type": "application/x-www-form-urlencoded" } } },
    });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ body: { name: "widget", qty: 3 } });
    expect(activeServer.requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(activeServer.requests[0]?.body).toBe("name=widget&qty=3");
  });

  test("a form-urlencoded body that skips explicit-undefined properties and tolerates a missing/non-object body", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({
      method: "post",
      path: "/x",
      parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body", "x-wappy-media-type": "application/x-www-form-urlencoded" } } },
    });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });

    await execute({ body: { name: "widget", note: undefined } });
    expect(activeServer.requests[0]?.body).toBe("name=widget");

    await execute({ body: undefined });
    expect(activeServer.requests[1]?.body).toBe("");
  });

  test("a body declaring an unsupported media type (e.g. multipart/form-data) fails as a normalized ToolResult, not a silently wrong request", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "{}" }));
    const t = tool({
      method: "post",
      path: "/x",
      parameters: { type: "object", properties: { body: { type: "object", "x-wappy-in": "body", "x-wappy-media-type": "multipart/form-data" } } },
    });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ body: { name: "widget" } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("multipart/form-data");
    expect(activeServer.requests).toHaveLength(0); // never sent a mismatched request
  });
});

describe("buildExecutor — default envReader falls back to process.env", () => {
  test("when no envReader is supplied, the real process.env is used", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    process.env.WAPPY_TEST_EXECUTOR_TOKEN = "real-env-value";
    try {
      const execute = buildExecutor(tool(), {
        baseUrl: activeServer.url,
        auth: { kind: "bearer", envVar: "WAPPY_TEST_EXECUTOR_TOKEN" },
        ssrf: { allowPrivateNetworks: true },
      });
      await execute({ id: "x" });
      expect(activeServer.requests[0]?.headers.authorization).toBe("Bearer real-env-value");
    } finally {
      delete process.env.WAPPY_TEST_EXECUTOR_TOKEN;
    }
  });
});

describe("buildExecutor — remaining edge cases", () => {
  test("a tool with no 'properties' at all in its parameters schema doesn't crash", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object" } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ anything: "ignored" });
    expect(result.ok).toBe(true);
  });

  test("a property with no recognized x-wappy-in location is silently ignored, not sent anywhere", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { mystery: { type: "string" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ mystery: "value" });
    expect(activeServer.requests[0]?.path).toBe("/x");
    expect(activeServer.requests[0]?.headers.mystery).toBeUndefined();
  });

  test("an explicit undefined cookie-param value is omitted, not sent as 'undefined'", async () => {
    activeServer = await startServer(() => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }));
    const t = tool({ path: "/x", parameters: { type: "object", properties: { session: { type: "string", "x-wappy-in": "cookie" } } } });
    const execute = buildExecutor(t, { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    await execute({ session: undefined });
    expect(activeServer.requests[0]?.headers.cookie).toBeUndefined();
  });

  test("a non-Error value rejected from the fetch layer is still normalized into a failed ToolResult", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "{}" }));
    const fetchImpl = () => Promise.reject("a plain string rejection, not an Error instance");
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true, fetchImpl } });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("plain string rejection");
  });

  test("a non-ok response with a completely empty body falls back to the HTTP status text in the error", async () => {
    activeServer = await startServer(() => ({ status: 400 }));
    const execute = buildExecutor(tool(), { baseUrl: activeServer.url, auth: NO_AUTH, ssrf: { allowPrivateNetworks: true } });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("400");
  });

  test("a non-Error value thrown before any network call (e.g. from a hostile envReader) is still normalized", async () => {
    activeServer = await startServer(() => ({ status: 200, body: "{}" }));
    const execute = buildExecutor(tool(), {
      baseUrl: activeServer.url,
      auth: { kind: "bearer", envVar: "X" },
      envReader: () => {
        throw "a plain string throw from envReader";
      },
      ssrf: { allowPrivateNetworks: true },
    });
    const result = await execute({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("plain string throw");
  });
});
