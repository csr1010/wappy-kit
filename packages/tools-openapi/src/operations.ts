import type { OpenAPIV3 } from "openapi-types";
import type { JsonSchema } from "@wappy/core";
import { resolveJsonPointer, resolveSchema } from "./schema.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 500;

export type ParamLocation = "path" | "query" | "header" | "cookie" | "body";

/** One operation turned into a tool's shape — `execute` is attached later (T7.5/T7.9); this is the
 * static, install-time-computable part (§8 T7.2). */
export interface GeneratedTool {
  name: string;
  description: string;
  /** A single flattened JSON Schema object; every property carries `"x-wappy-in"` (ParamLocation) so
   * the executor (T7.5) knows where to place each argument on the real HTTP request. */
  parameters: JsonSchema;
  method: HttpMethod;
  path: string;
  operationId?: string;
  operation: OpenAPIV3.OperationObject;
}

export interface SkipReportEntry {
  method: string;
  path: string;
  operationId?: string;
  reason: string;
}

export interface GenerateToolsResult {
  tools: GeneratedTool[];
  skipped: SkipReportEntry[];
}

type ParamOrRef = OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject;
type SchemaOrRef = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;

function isRef<T>(v: T | OpenAPIV3.ReferenceObject): v is OpenAPIV3.ReferenceObject {
  return typeof v === "object" && v !== null && "$ref" in v;
}

function resolveParam(p: ParamOrRef, document: OpenAPIV3.Document): OpenAPIV3.ParameterObject {
  return isRef(p) ? (resolveJsonPointer(p.$ref, document) as OpenAPIV3.ParameterObject) : p;
}

function sanitizeName(raw: string): string {
  // A 1-for-1 character replace can never shrink the string, and both call sites only invoke this
  // with a non-empty string (generateTools() only calls it when operationId is truthy; deriveName()
  // always includes a literal "_" plus a non-empty method name) — so `cleaned` is always non-empty.
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

function deriveName(method: string, path: string): string {
  const cleanedPath = path
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/^\//, "")
    .replace(/\//g, "_");
  return sanitizeName(`${method}_${cleanedPath}`);
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function boundedDescription(summary?: string, description?: string): string {
  const text = summary || description || "";
  if (text.length === 0) return "(no description provided)";
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

interface RawOperationEntry {
  method: HttpMethod;
  path: string;
  operation: OpenAPIV3.OperationObject;
  pathItemParameters: ParamOrRef[];
}

function extractOperations(document: OpenAPIV3.Document): RawOperationEntry[] {
  const out: RawOperationEntry[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;
    const pathItemParameters = ((pathItem as OpenAPIV3.PathItemObject).parameters ?? []) as ParamOrRef[];
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as unknown as Record<string, OpenAPIV3.OperationObject | undefined>)[method];
      if (!operation) continue;
      out.push({ method, path, operation, pathItemParameters });
    }
  }
  return out;
}

function buildParametersSchema(operation: OpenAPIV3.OperationObject, pathItemParameters: ParamOrRef[], document: OpenAPIV3.Document): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const byKey = new Map<string, OpenAPIV3.ParameterObject>();
  const allRaw = [...pathItemParameters, ...((operation.parameters ?? []) as ParamOrRef[])];
  for (const raw of allRaw) {
    const p = resolveParam(raw, document);
    byKey.set(`${p.in}:${p.name}`, p); // operation-level entries processed after path-item ones, so they win
  }

  for (const p of byKey.values()) {
    const schema = resolveSchema(p.schema as SchemaOrRef | undefined, { document }) ?? {};
    // The Parameter Object's own `description` (a sibling of `schema`, per the OAS spec) takes
    // priority over the schema's — specs commonly document a parameter's meaning there instead.
    properties[p.name] = { ...schema, ...(p.description ? { description: p.description } : {}), "x-wappy-in": p.in };
    if (p.required) required.push(p.name);
  }

  if (operation.requestBody) {
    const rb = isRef(operation.requestBody) ? (resolveJsonPointer(operation.requestBody.$ref, document) as OpenAPIV3.RequestBodyObject) : operation.requestBody;
    const content = rb.content ?? {};
    const mediaType = "application/json" in content ? "application/json" : Object.keys(content)[0];
    if (mediaType) {
      const bodySchema = resolveSchema(content[mediaType]?.schema as SchemaOrRef | undefined, { document }) ?? {};
      properties.body = { ...bodySchema, "x-wappy-in": "body", "x-wappy-media-type": mediaType };
      if (rb.required) required.push("body");
    }
  }

  const result: JsonSchema = { type: "object", properties };
  if (required.length > 0) result.required = required;
  return result;
}

/**
 * Generates one Tool shape per operation in a bundled OpenAPI 3.x document (§8 T7.2): name from
 * `operationId` (sanitized to `^[a-zA-Z0-9_-]{1,64}$`, collision-safe) or derived from method+path;
 * description from summary/description, bounded length; path/query/header/cookie parameters and the
 * request body flattened into one JSON Schema, each property tagged `"x-wappy-in"`. An operation
 * whose schema can't be mapped (a broken `$ref`) is skipped, not emitted broken — every other
 * operation in the spec is still generated.
 */
export function generateTools(document: OpenAPIV3.Document): GenerateToolsResult {
  const tools: GeneratedTool[] = [];
  const skipped: SkipReportEntry[] = [];
  const usedNames = new Set<string>();

  for (const { method, path, operation, pathItemParameters } of extractOperations(document)) {
    try {
      const baseName = operation.operationId ? sanitizeName(operation.operationId) : deriveName(method, path);
      const name = uniqueName(baseName, usedNames);
      const description = boundedDescription(operation.summary, operation.description);
      const parameters = buildParametersSchema(operation, pathItemParameters, document);
      tools.push({ name, description, parameters, method, path, operationId: operation.operationId, operation });
    } catch (e) {
      // The only thing that can throw inside the try block is resolveSchema/resolveJsonPointer,
      // which only ever throw SchemaUnmappableError — always an Error, so `.message` is always safe.
      skipped.push({ method, path, operationId: operation.operationId, reason: (e as Error).message });
    }
  }

  return { tools, skipped };
}

export { NAME_PATTERN };
