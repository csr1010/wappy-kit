import type { Tool, ToolProvider, JsonSchema } from "@wappy/core";
import { loadSpec } from "./load.js";
import { generateTools, type GeneratedTool } from "./operations.js";
import { resolveAuth, type ResolvedAuth } from "./auth.js";
import { applyPolicy, type PolicyOptions } from "./policy.js";
import { curate, type CurateOptions } from "./curate.js";
import { buildExecutor, type ExecutorOptions } from "./executor.js";
import { assertSafeUrl, type SafeFetchOptions } from "./ssrf.js";

export interface ProviderSkipEntry {
  /** The generated tool name, or (when generation itself failed) a method_path-derived label. */
  name: string;
  method?: string;
  path?: string;
  reason: string;
}

export interface CreateOpenApiToolProviderOptions {
  name: string;
  /** A spec URL, local file path, or already-parsed object — passed straight to loadSpec(). */
  source: string | Record<string, unknown>;
  /** Prefix for every derived auth env-var name (e.g. "SHOPIFY_"). Required — there's no safe
   * generic default that avoids collisions across multiple installed tool sources. */
  envPrefix: string;
  /** Overrides the spec's own `servers[0].url`. Required if the spec declares no servers. */
  baseUrl?: string;
  policy?: PolicyOptions;
  curation?: CurateOptions;
  executorOptions?: Partial<Pick<ExecutorOptions, "timeoutMs" | "maxResponseBytes" | "maxRetries" | "retryDelayMs" | "envReader">>;
  /** Applied to the entry spec-URL fetch (loadSpec) AND every real tool-call request this provider's
   * tools make (executor). */
  ssrf?: SafeFetchOptions;
}

export interface CreateOpenApiToolProviderResult {
  provider: ToolProvider;
  /** Every operation that didn't become a callable tool, and why — unmappable schemas (T7.2),
   * unsupported auth (T7.4), policy exclusion (T7.6), and curation drops (T7.7) are all reported
   * here, uniformly, so nothing silently vanishes (§8 "skip and add to SkipReport"). */
  skipReport: ProviderSkipEntry[];
}

/** Strips the internal "x-wappy-*" location metadata operations.ts/executor.ts rely on before a
 * schema is exposed as a public Tool.parameters — a model consuming the tool shouldn't see it. */
function stripLocationMetadata(schema: JsonSchema): JsonSchema {
  if (typeof schema !== "object" || schema === null) return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "x-wappy-in" || key === "x-wappy-media-type") continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      const strippedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        strippedProps[propName] = stripLocationMetadata(propSchema as JsonSchema);
      }
      out[key] = strippedProps;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Builds a real, executable `ToolProvider` from an OpenAPI/Swagger spec (§8 T7.9): loads + validates
 * the spec (T7.1), generates one Tool shape per operation (T7.2/T7.3), resolves auth per operation
 * (T7.4), applies the readOnly/confirmBefore/DELETE-gate policy (T7.6), curates the survivors
 * (T7.7), and attaches a real SSRF-guarded HTTP executor (T7.5/T7.8) to each one that's left. Every
 * operation that drops out along the way is reported in `skipReport` with a reason.
 */
export async function createOpenApiToolProvider(opts: CreateOpenApiToolProviderOptions): Promise<CreateOpenApiToolProviderResult> {
  const { document } = await loadSpec(opts.source, opts.ssrf);
  const { tools: generated, skipped: unmappable } = generateTools(document);

  const skipReport: ProviderSkipEntry[] = unmappable.map((s) => ({ name: s.operationId ?? `${s.method}_${s.path}`, method: s.method, path: s.path, reason: s.reason }));

  const authByToolName = new Map<string, ResolvedAuth>();
  const afterAuth: GeneratedTool[] = [];
  for (const tool of generated) {
    const resolved = resolveAuth(tool.operation, document, opts.envPrefix);
    if ("skip" in resolved) {
      skipReport.push({ name: tool.name, method: tool.method, path: tool.path, reason: resolved.skip.reason });
      continue;
    }
    authByToolName.set(tool.name, resolved.auth);
    afterAuth.push(tool);
  }

  const afterPolicy: GeneratedTool[] = [];
  for (const tool of afterAuth) {
    const decision = applyPolicy(tool, opts.policy);
    if (!decision.included) {
      skipReport.push({ name: tool.name, method: tool.method, path: tool.path, reason: decision.reason ?? "Excluded by policy." });
      continue;
    }
    afterPolicy.push(tool);
  }

  const { tools: curated, dropped: curationDrops } = curate(afterPolicy, opts.curation);
  for (const d of curationDrops) skipReport.push({ name: d.tool.name, method: d.tool.method, path: d.tool.path, reason: d.reason });

  const baseUrl = opts.baseUrl ?? document.servers?.[0]?.url;
  if (!baseUrl) {
    throw new Error(`createOpenApiToolProvider("${opts.name}"): no baseUrl was supplied and the spec declares no servers[] — cannot make any real HTTP call without one.`);
  }
  await assertSafeUrl(baseUrl, opts.ssrf); // fail loud at install, not on the first real tool call

  const tools: Tool[] = curated.map((generatedTool) => {
    const decision = applyPolicy(generatedTool, opts.policy);
    const auth = authByToolName.get(generatedTool.name)!;
    const execute = buildExecutor(generatedTool, { baseUrl, auth, ...opts.executorOptions, ssrf: opts.ssrf });
    return {
      name: generatedTool.name,
      description: generatedTool.description,
      parameters: stripLocationMetadata(generatedTool.parameters),
      readOnly: decision.readOnly,
      confirmBefore: decision.confirmBefore,
      execute,
    };
  });

  return { provider: { name: opts.name, listTools: () => tools }, skipReport };
}
