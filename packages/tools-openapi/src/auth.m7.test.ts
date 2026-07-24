import { describe, expect, test } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { applyAuth, resolveAuth } from "./auth.js";

function doc(securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>, security?: OpenAPIV3.SecurityRequirementObject[]): OpenAPIV3.Document {
  return {
    openapi: "3.0.3",
    info: { title: "x", version: "1" },
    paths: {},
    components: { securitySchemes },
    ...(security ? { security } : {}),
  } as OpenAPIV3.Document;
}

function op(security?: OpenAPIV3.SecurityRequirementObject[]): OpenAPIV3.OperationObject {
  return { responses: { 200: { description: "ok" } }, ...(security ? { security } : {}) };
}

describe("resolveAuth — no security required", () => {
  test("an operation with no security requirement (and no document default) resolves to 'none'", () => {
    const result = resolveAuth(op(), doc({}), "MYAPI_");
    expect(result).toEqual({ auth: { kind: "none" } });
  });

  test("an operation with an explicit empty security array ([]) also resolves to 'none' (opts out of the document default)", () => {
    const result = resolveAuth(op([]), doc({ apiKeyAuth: { type: "apiKey", name: "X-Api-Key", in: "header" } }, [{ apiKeyAuth: [] }]), "MYAPI_");
    expect(result).toEqual({ auth: { kind: "none" } });
  });

  test("an individual empty requirement object ({}) among non-empty alternatives means auth is optional", () => {
    const document = doc({ apiKeyAuth: { type: "apiKey", name: "k", in: "header" } });
    const result = resolveAuth(op([{}]), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "none" } });
  });
});

describe("resolveAuth — apiKey", () => {
  test("an apiKey scheme in a header resolves with the header name and a derived env var", () => {
    const document = doc({ apiKeyAuth: { type: "apiKey", name: "X-Api-Key", in: "header" } }, [{ apiKeyAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "apiKey", in: "header", paramName: "X-Api-Key", envVar: "MYAPI_APIKEYAUTH" } });
  });

  test("an apiKey scheme in a query param is resolved the same way, with in: 'query'", () => {
    const document = doc({ apiKeyAuth: { type: "apiKey", name: "api_key", in: "query" } }, [{ apiKeyAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "apiKey", in: "query", paramName: "api_key", envVar: "MYAPI_APIKEYAUTH" } });
  });

  test("an apiKey scheme in a cookie is resolved with in: 'cookie'", () => {
    const document = doc({ session: { type: "apiKey", name: "session_id", in: "cookie" } }, [{ session: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "apiKey", in: "cookie", paramName: "session_id", envVar: "MYAPI_SESSION" } });
  });

  test("the env var name is derived from the scheme name, uppercased with non-alnum replaced", () => {
    const document = doc({ "my-api key.v2": { type: "apiKey", name: "k", in: "header" } }, [{ "my-api key.v2": [] }]);
    const result = resolveAuth(op(), document, "P_");
    expect(result).toEqual({ auth: { kind: "apiKey", in: "header", paramName: "k", envVar: "P_MY_API_KEY_V2" } });
  });
});

describe("resolveAuth — http bearer / basic", () => {
  test("http bearer resolves to kind 'bearer' with a derived env var", () => {
    const document = doc({ bearerAuth: { type: "http", scheme: "bearer" } }, [{ bearerAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "bearer", envVar: "MYAPI_BEARERAUTH" } });
  });

  test("http basic resolves to kind 'basic' with separate username/password env vars", () => {
    const document = doc({ basicAuth: { type: "http", scheme: "basic" } }, [{ basicAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "basic", usernameEnvVar: "MYAPI_BASICAUTH_USERNAME", passwordEnvVar: "MYAPI_BASICAUTH_PASSWORD" } });
  });
});

describe("resolveAuth — operation-level security overrides the document default", () => {
  test("an operation's own security requirement is used instead of the document's default", () => {
    const document = doc(
      { docDefault: { type: "apiKey", name: "d", in: "header" }, opScheme: { type: "http", scheme: "bearer" } },
      [{ docDefault: [] }],
    );
    const result = resolveAuth(op([{ opScheme: [] }]), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "bearer", envVar: "MYAPI_OPSCHEME" } });
  });
});

describe("resolveAuth — unsupported schemes skip with an explicit reason", () => {
  test("oauth2 is explicitly unsupported in v0.1", () => {
    const document = doc({ oauth: { type: "oauth2", flows: {} } }, [{ oauth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
    expect((result as { skip: { reason: string } }).skip.reason).toMatch(/oauth2/i);
    expect((result as { skip: { reason: string } }).skip.reason).toMatch(/v0\.1|unsupported/i);
  });

  test("openIdConnect is also explicitly unsupported", () => {
    const document = doc({ oidc: { type: "openIdConnect", openIdConnectUrl: "https://example.com" } }, [{ oidc: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
  });

  test("an http scheme other than bearer/basic (e.g. digest) is unsupported", () => {
    const document = doc({ digestAuth: { type: "http", scheme: "digest" } }, [{ digestAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
    expect((result as { skip: { reason: string } }).skip.reason).toMatch(/digest/i);
  });

  test("a security scheme type this v0.1 doesn't recognize at all is unsupported, not a crash", () => {
    const document = doc({ mtls: { type: "mutualTLS" } } as never, [{ mtls: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
    expect((result as { skip: { reason: string } }).skip.reason).toMatch(/mutualTLS/);
  });

  test("a security requirement combining multiple schemes (AND semantics) is unsupported", () => {
    const document = doc({ a: { type: "apiKey", name: "a", in: "header" }, b: { type: "apiKey", name: "b", in: "header" } }, [{ a: [], b: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
  });

  test("a security requirement referencing a scheme name that doesn't exist in securitySchemes is unsupported, not a crash", () => {
    const document = doc({}, [{ ghost: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect("skip" in result).toBe(true);
  });

  test("multiple alternative requirements: the first SUPPORTED alternative is used, even if an earlier one is oauth2", () => {
    const document = doc({ oauth: { type: "oauth2", flows: {} }, apiKeyAuth: { type: "apiKey", name: "k", in: "header" } }, [{ oauth: [] }, { apiKeyAuth: [] }]);
    const result = resolveAuth(op(), document, "MYAPI_");
    expect(result).toEqual({ auth: { kind: "apiKey", in: "header", paramName: "k", envVar: "MYAPI_APIKEYAUTH" } });
  });
});

describe("applyAuth — injects the real secret at call time from an env reader", () => {
  test("apiKey in header produces a headers fragment", () => {
    const env = new Map([["MYAPI_APIKEYAUTH", "secret123"]]);
    const result = applyAuth({ kind: "apiKey", in: "header", paramName: "X-Api-Key", envVar: "MYAPI_APIKEYAUTH" }, (k) => env.get(k));
    expect(result).toEqual({ headers: { "X-Api-Key": "secret123" } });
  });

  test("apiKey in query produces a query fragment", () => {
    const env = new Map([["MYAPI_APIKEYAUTH", "secret123"]]);
    const result = applyAuth({ kind: "apiKey", in: "query", paramName: "api_key", envVar: "MYAPI_APIKEYAUTH" }, (k) => env.get(k));
    expect(result).toEqual({ query: { api_key: "secret123" } });
  });

  test("apiKey in cookie produces a cookies fragment", () => {
    const env = new Map([["MYAPI_SESSION", "abc"]]);
    const result = applyAuth({ kind: "apiKey", in: "cookie", paramName: "session_id", envVar: "MYAPI_SESSION" }, (k) => env.get(k));
    expect(result).toEqual({ cookies: { session_id: "abc" } });
  });

  test("bearer produces an Authorization header", () => {
    const env = new Map([["MYAPI_BEARERAUTH", "tok"]]);
    const result = applyAuth({ kind: "bearer", envVar: "MYAPI_BEARERAUTH" }, (k) => env.get(k));
    expect(result).toEqual({ headers: { Authorization: "Bearer tok" } });
  });

  test("basic produces a base64-encoded Authorization header from username+password", () => {
    const env = new Map([
      ["MYAPI_BASICAUTH_USERNAME", "alice"],
      ["MYAPI_BASICAUTH_PASSWORD", "hunter2"],
    ]);
    const result = applyAuth({ kind: "basic", usernameEnvVar: "MYAPI_BASICAUTH_USERNAME", passwordEnvVar: "MYAPI_BASICAUTH_PASSWORD" }, (k) => env.get(k));
    expect(result).toEqual({ headers: { Authorization: `Basic ${Buffer.from("alice:hunter2").toString("base64")}` } });
  });

  test("kind 'none' produces no fragment at all", () => {
    const result = applyAuth({ kind: "none" }, () => undefined);
    expect(result).toEqual({});
  });

  test("a missing env var throws loudly at call time rather than silently sending an unauthenticated/malformed request", () => {
    expect(() => applyAuth({ kind: "bearer", envVar: "MISSING_VAR" }, () => undefined)).toThrow(/MISSING_VAR/);
  });

  test("a missing username or password for basic auth throws loudly, naming the specific missing var", () => {
    expect(() =>
      applyAuth({ kind: "basic", usernameEnvVar: "U", passwordEnvVar: "P" }, (k) => (k === "U" ? "alice" : undefined)),
    ).toThrow(/P/);
  });
});
