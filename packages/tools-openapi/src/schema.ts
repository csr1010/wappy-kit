import type { OpenAPIV3 } from "openapi-types";
import type { JsonSchema } from "@wappy/core";

/** Thrown when a schema genuinely can't be mapped (e.g. a `$ref` that doesn't resolve to anything
 * after bundling) — distinct from circular/deep schemas, which degrade gracefully instead (§8 T7.3). */
export class SchemaUnmappableError extends Error {}

export interface ResolveSchemaOptions {
  /** The full bundled OpenAPI 3.x document — `$ref`s are resolved as JSON pointers against this. */
  document: OpenAPIV3.Document;
  /** Caps recursion for legitimately deep (non-circular) schemas AND stops circular `$ref` chains
   * from recursing forever — beyond this depth, a nested schema degrades to `{}` (any) rather than
   * being fully expanded. Default 6: deep enough for real-world specs, shallow enough to bound size. */
  maxDepth?: number;
}

type SchemaOrRef = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;

const DEFAULT_MAX_DEPTH = 6;

/** Keywords copied verbatim when present — a deliberate allow-list, not the full raw schema, so
 * OpenAPI-only metadata (discriminator, xml, externalDocs, example, ...) doesn't leak into the JSON
 * Schema a model sees as a tool's call signature. */
const SCALAR_KEYWORDS = [
  "type",
  "description",
  "enum",
  "format",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;

function isRef(schema: SchemaOrRef): schema is OpenAPIV3.ReferenceObject {
  return typeof schema === "object" && schema !== null && "$ref" in schema;
}

function decodeRefToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolves any local `$ref` JSON pointer (parameter/requestBody/schema/...) against the bundled
 * document — shared by operations.ts for non-schema `$ref`s (e.g. `components/parameters/X`). */
export function resolveJsonPointer(ref: string, document: OpenAPIV3.Document): unknown {
  if (!ref.startsWith("#/")) {
    throw new SchemaUnmappableError(`Unsupported $ref (not a local pointer — should have been bundled): ${ref}`);
  }
  let node: unknown = document;
  for (const rawToken of ref.slice(2).split("/")) {
    const token = decodeRefToken(rawToken);
    if (typeof node !== "object" || node === null) throw new SchemaUnmappableError(`Broken $ref, no object at this point in the path: ${ref}`);
    node = (node as Record<string, unknown>)[token];
  }
  if (node === undefined) throw new SchemaUnmappableError(`Broken $ref, does not resolve to anything: ${ref}`);
  return node;
}

function mergeAllOf(members: JsonSchema[]): JsonSchema {
  const merged: JsonSchema = { type: "object", properties: {}, required: [] };
  const properties = merged.properties as Record<string, unknown>;
  const required = merged.required as string[];
  for (const member of members) {
    if (member.type && member.type !== "object") merged.type = member.type; // last non-object type wins if present
    if (member.properties) Object.assign(properties, member.properties as Record<string, unknown>);
    if (Array.isArray(member.required)) required.push(...(member.required as string[]));
    // A member that's ITSELF a discriminated union (e.g. `allOf: [Base, {oneOf: [Cat, Dog]}]`, a
    // common real-world composition pattern) must not have its oneOf/anyOf silently dropped just
    // because mergeAllOf otherwise only looks at properties/required/scalar keywords. If MULTIPLE
    // members each declare their own oneOf/anyOf (combining two discriminated unions via allOf is
    // itself an unusual, out-of-v0.1-scope shape), the LAST member's wins — matching how every other
    // per-member keyword here (type, scalar keywords) is merged, not a special case for this one.
    if (member.oneOf) merged.oneOf = member.oneOf;
    if (member.anyOf) merged.anyOf = member.anyOf;
    for (const key of SCALAR_KEYWORDS) {
      if (key in member && key !== "type") merged[key] = member[key];
    }
  }
  if (Object.keys(properties).length === 0) delete merged.properties;
  const dedupedRequired = [...new Set(required)];
  if (dedupedRequired.length > 0) merged.required = dedupedRequired;
  else delete merged.required;
  return merged;
}

/**
 * Resolves an OpenAPI 3.x schema (or `$ref` to one) into a plain JSON Schema object (§8 T7.3):
 * `$ref` is followed as a local JSON pointer (external refs are assumed already bundled by
 * loadSpec's `SwaggerParser.bundle()`); `allOf` is merged into one object schema; `oneOf`/`anyOf`
 * are preserved natively (JSON Schema supports both directly — each branch is itself resolved);
 * `properties`/`items` recurse with the depth cap below. A **cycle** (the same `$ref` string seen
 * twice in the current resolution chain) or exceeding `maxDepth` both degrade to `{}` (any) rather
 * than throwing — only a genuinely broken `$ref` (`SchemaUnmappableError`) is a hard failure.
 */
export function resolveSchema(schema: SchemaOrRef | undefined, opts: ResolveSchemaOptions): JsonSchema | undefined {
  return resolveInner(schema, opts, new Set<string>(), 0);
}

// Every recursive resolveInner() call below passes a schema value that's already known non-undefined
// (an array element from .map() over a real array, a property value from Object.entries(), a
// truthy-checked `items`/`additionalProperties`) — resolveInner() only ever returns undefined for a
// literal `undefined` input (its very first check), so none of these recursive calls can produce
// undefined; the `!` assertions below reflect that, not a fallback that's actually reachable.
function resolveInner(schema: SchemaOrRef | undefined, opts: ResolveSchemaOptions, seenRefs: Set<string>, depth: number): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  if (depth > (opts.maxDepth ?? DEFAULT_MAX_DEPTH)) return {};

  if (isRef(schema)) {
    if (seenRefs.has(schema.$ref)) return {}; // circular — stop expanding, degrade to "any"
    const resolved = resolveJsonPointer(schema.$ref, opts.document) as SchemaOrRef;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(schema.$ref);
    return resolveInner(resolved, opts, nextSeen, depth + 1);
  }

  const hasAllOf = Array.isArray(schema.allOf) && schema.allOf.length > 0;
  const hasOneOf = Array.isArray(schema.oneOf) && schema.oneOf.length > 0;
  const hasAnyOf = Array.isArray(schema.anyOf) && schema.anyOf.length > 0;

  // These are composable, not mutually exclusive — a schema can legitimately combine a base
  // (allOf) with a discriminated union of the SAME node (sibling oneOf/anyOf), not just nested
  // inside one allOf member (handled by mergeAllOf itself, above).
  if (hasAllOf) {
    const members = (schema.allOf as SchemaOrRef[]).map((m) => resolveInner(m, opts, seenRefs, depth + 1)!);
    const merged = mergeAllOf(members);
    if (hasOneOf) merged.oneOf = (schema.oneOf as SchemaOrRef[]).map((m) => resolveInner(m, opts, seenRefs, depth + 1)!);
    if (hasAnyOf) merged.anyOf = (schema.anyOf as SchemaOrRef[]).map((m) => resolveInner(m, opts, seenRefs, depth + 1)!);
    return merged;
  }

  if (hasOneOf) {
    return { oneOf: (schema.oneOf as SchemaOrRef[]).map((m) => resolveInner(m, opts, seenRefs, depth + 1)!) };
  }

  if (hasAnyOf) {
    return { anyOf: (schema.anyOf as SchemaOrRef[]).map((m) => resolveInner(m, opts, seenRefs, depth + 1)!) };
  }

  const out: JsonSchema = {};
  for (const key of SCALAR_KEYWORDS) {
    if (key in schema) out[key] = (schema as Record<string, unknown>)[key];
  }

  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      properties[name] = resolveInner(propSchema as SchemaOrRef, opts, seenRefs, depth + 1)!;
    }
    out.properties = properties;
    out.type = out.type ?? "object";
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;

  const items = (schema as { items?: SchemaOrRef }).items;
  if (items) {
    out.items = resolveInner(items, opts, seenRefs, depth + 1)!;
    out.type = out.type ?? "array";
  }

  if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
    out.additionalProperties = resolveInner(schema.additionalProperties as SchemaOrRef, opts, seenRefs, depth + 1)!;
  } else if (typeof schema.additionalProperties === "boolean") {
    out.additionalProperties = schema.additionalProperties;
  }

  return out;
}
