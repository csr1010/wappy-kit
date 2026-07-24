import type { OpenAPIV3 } from "openapi-types";

export type ResolvedAuth =
  | { kind: "none" }
  | { kind: "apiKey"; in: "header" | "query" | "cookie"; paramName: string; envVar: string }
  | { kind: "bearer"; envVar: string }
  | { kind: "basic"; usernameEnvVar: string; passwordEnvVar: string };

export interface AuthSkip {
  reason: string;
}

export type ResolveAuthResult = { auth: ResolvedAuth } | { skip: AuthSkip };

function envVarName(prefix: string, schemeName: string): string {
  return `${prefix}${schemeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function resolveScheme(schemeName: string, scheme: OpenAPIV3.SecuritySchemeObject, envPrefix: string): ResolveAuthResult {
  if (scheme.type === "apiKey") {
    return { auth: { kind: "apiKey", in: scheme.in as "header" | "query" | "cookie", paramName: scheme.name, envVar: envVarName(envPrefix, schemeName) } };
  }
  if (scheme.type === "http") {
    if (scheme.scheme === "bearer") return { auth: { kind: "bearer", envVar: envVarName(envPrefix, schemeName) } };
    if (scheme.scheme === "basic") {
      const base = envVarName(envPrefix, schemeName);
      return { auth: { kind: "basic", usernameEnvVar: `${base}_USERNAME`, passwordEnvVar: `${base}_PASSWORD` } };
    }
    return { skip: { reason: `HTTP auth scheme "${scheme.scheme}" is unsupported in v0.1 (only bearer/basic).` } };
  }
  if (scheme.type === "oauth2") return { skip: { reason: "OAuth2 is unsupported in v0.1 — explicit skip, not a broken tool." } };
  if (scheme.type === "openIdConnect") return { skip: { reason: "OpenID Connect is unsupported in v0.1 — explicit skip, not a broken tool." } };
  return { skip: { reason: `Unrecognized security scheme type "${(scheme as { type: string }).type}" is unsupported in v0.1.` } };
}

/**
 * Resolves an operation's effective security requirement (operation-level `security`, falling back
 * to the document's default) into a `ResolvedAuth` describing WHERE the secret goes and WHICH env
 * var holds it — no env access happens here (§8 T7.4, "secrets read from env at call time"; see
 * `applyAuth` for that step). A requirement this v0.1 can't satisfy (OAuth2/OIDC, an AND-combination
 * of multiple schemes, or a dangling scheme reference) resolves to an explicit `{skip}` with a human
 * reason, rather than silently producing a broken/unauthenticated tool.
 */
export function resolveAuth(operation: OpenAPIV3.OperationObject, document: OpenAPIV3.Document, envPrefix: string): ResolveAuthResult {
  const requirements = operation.security ?? document.security ?? [];
  if (requirements.length === 0) return { auth: { kind: "none" } };

  const schemes = document.components?.securitySchemes ?? {};
  // Placeholder only — every requirement (requirements.length > 0 here) either returns early or
  // overwrites this below, so its text is never actually the one returned; TS still requires an
  // initializer since it can't prove the loop always assigns before the final `return`.
  let lastSkip: AuthSkip = { reason: "No security requirement could be satisfied." };

  for (const requirement of requirements) {
    const schemeNames = Object.keys(requirement);
    if (schemeNames.length === 0) return { auth: { kind: "none" } }; // an empty {} alternative means "no auth needed"
    if (schemeNames.length > 1) {
      lastSkip = { reason: `A security requirement combining multiple schemes (${schemeNames.join(", ")}) is unsupported in v0.1.` };
      continue;
    }
    const schemeName = schemeNames[0]!;
    const scheme = schemes[schemeName];
    if (!scheme || "$ref" in scheme) {
      lastSkip = { reason: `Security scheme "${schemeName}" is missing from components.securitySchemes (or is an unresolved $ref).` };
      continue;
    }
    const result = resolveScheme(schemeName, scheme, envPrefix);
    if ("auth" in result) return result;
    lastSkip = result.skip;
  }

  return { skip: lastSkip };
}

export interface AuthRequestFragment {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  cookies?: Record<string, string>;
}

function requireEnv(envVar: string, read: (name: string) => string | undefined): string {
  const value = read(envVar);
  if (!value) throw new Error(`Missing required secret: environment variable "${envVar}" is not set.`);
  return value;
}

/**
 * Applies a `ResolvedAuth` at CALL time, reading the actual secret via `read` (defaults to
 * `process.env` when wired by the executor) — never at install/generation time. Throws loudly on a
 * missing secret rather than sending an unauthenticated or malformed request (§11 "secrets via env").
 */
export function applyAuth(auth: ResolvedAuth, read: (name: string) => string | undefined): AuthRequestFragment {
  switch (auth.kind) {
    case "none":
      return {};
    case "apiKey": {
      const value = requireEnv(auth.envVar, read);
      if (auth.in === "header") return { headers: { [auth.paramName]: value } };
      if (auth.in === "query") return { query: { [auth.paramName]: value } };
      return { cookies: { [auth.paramName]: value } };
    }
    case "bearer": {
      const value = requireEnv(auth.envVar, read);
      return { headers: { Authorization: `Bearer ${value}` } };
    }
    case "basic": {
      const username = requireEnv(auth.usernameEnvVar, read);
      const password = requireEnv(auth.passwordEnvVar, read);
      return { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } };
    }
  }
}
