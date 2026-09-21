import SwaggerParser from "@apidevtools/swagger-parser";
import { convertObj } from "swagger2openapi";
import { load as loadYaml } from "js-yaml";
import type { OpenAPIV3 } from "openapi-types";
import { fetchSafely, type SafeFetchOptions } from "./ssrf.js";

export interface SpecPointerError {
  /** JSON pointer into the spec document, e.g. "/paths/~1pets/get/responses" ("" if unknown). */
  pointer: string;
  message: string;
}

/** Thrown by loadSpec() for any load/convert/validate failure — always includes a human-readable
 * message, and `errors` with JSON-pointer locations when the underlying validator provides them
 * (§10 "unparseable/huge spec -> skip bad ops + curate; fail loud at install, not runtime"). */
export class SpecLoadError extends Error {
  readonly errors: SpecPointerError[];
  constructor(message: string, errors: SpecPointerError[] = []) {
    super(message);
    this.name = "SpecLoadError";
    this.errors = errors;
  }
}

export interface LoadedSpec {
  /** Always OpenAPI 3.x — 2.0 inputs are converted before this is returned. External $refs are
   * bundled into this document; internal (including circular) $refs are left as literal `$ref`
   * strings for T7.3's own depth-limited resolver to flatten. */
  document: OpenAPIV3.Document;
  originalVersion: "2.0" | "3.0" | "3.1";
}

interface AjvLikeError {
  instancePath?: string;
  message?: string;
}

function pointerErrorsFrom(e: unknown): SpecPointerError[] {
  const details = (e as { details?: AjvLikeError[] } | undefined)?.details;
  if (!Array.isArray(details) || details.length === 0) return [];
  return details.map((d) => ({ pointer: d.instancePath || "/", message: d.message ?? "invalid" }));
}

const URL_PATTERN = /^https?:\/\//i;

async function fetchEntrySpec(url: string, ssrfOptions: SafeFetchOptions | undefined): Promise<unknown> {
  // Never hands the raw URL to SwaggerParser.parse() — its own built-in HTTP resolver has no SSRF
  // guard, so the entry spec URL is fetched and re-validated (incl. every redirect hop) here first,
  // and only the already-fetched TEXT is handed downstream (§8 T7.8, "spec-URL fetch").
  const response = await fetchSafely(url, ssrfOptions);
  if (!response.ok) throw new SpecLoadError(`Fetching spec from "${url}" failed: HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return loadYaml(text);
  }
}

function detectVersion(raw: unknown): "2.0" | "3.0" | "3.1" {
  const obj = raw as { swagger?: unknown; openapi?: unknown };
  if (typeof obj.swagger === "string" && obj.swagger.startsWith("2.")) return "2.0";
  if (typeof obj.openapi === "string" && obj.openapi.startsWith("3.1")) return "3.1";
  if (typeof obj.openapi === "string" && obj.openapi.startsWith("3.")) return "3.0";
  throw new SpecLoadError('Spec has neither a "swagger" (2.0) nor "openapi" (3.x) version field.');
}

/**
 * Loads an OpenAPI/Swagger spec from a URL, a local file path, or an already-parsed object;
 * normalizes Swagger 2.0 to OpenAPI 3.x; validates against the OAS 2.0/3.0/3.1 JSON Schema with
 * pointer-level errors; bundles external `$ref`s into one self-contained document (§8 T7.1). When
 * `source` is an http(s) URL, it's fetched through the SSRF guard (§8 T7.8) — `ssrfOptions` is
 * passed straight to `fetchSafely` (e.g. `{allowPrivateNetworks: true}` for a local dev spec server).
 * Note: this guards the ENTRY spec URL and its redirects; a spec's own EXTERNAL `$ref`s (resolved
 * during validate/bundle below) are fetched by swagger-parser's own resolver, not this guard — a
 * narrower, documented v0.1 scope limit (loading a spec is already a trust decision the caller makes).
 */
export async function loadSpec(source: string | Record<string, unknown>, ssrfOptions?: SafeFetchOptions): Promise<LoadedSpec> {
  let raw: unknown;
  try {
    if (typeof source === "string" && URL_PATTERN.test(source)) {
      raw = await fetchEntrySpec(source, ssrfOptions);
    } else {
      raw = typeof source === "string" ? await SwaggerParser.parse(source) : source;
    }
  } catch (e) {
    if (e instanceof SpecLoadError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new SpecLoadError(`Could not load spec from "${typeof source === "string" ? source : "<object>"}": ${message}`);
  }

  const originalVersion = detectVersion(raw);

  let doc: unknown = raw;
  if (originalVersion === "2.0") {
    try {
      const result = await convertObj(raw as Parameters<typeof convertObj>[0], {});
      doc = result.openapi;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new SpecLoadError(`Failed to convert Swagger 2.0 spec to OpenAPI 3.x: ${message}`);
    }
  }

  // validate() dereferences internally to check the schema; we only want its error reporting (with
  // JSON pointers), not its dereferenced (and possibly circular-object) result — bundle() below gives
  // us the document we actually use.
  try {
    await SwaggerParser.validate(structuredClone(doc) as OpenAPIV3.Document);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new SpecLoadError(`Spec failed validation: ${message}`, pointerErrorsFrom(e));
  }

  let bundled: OpenAPIV3.Document;
  try {
    bundled = (await SwaggerParser.bundle(structuredClone(doc) as OpenAPIV3.Document)) as OpenAPIV3.Document;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new SpecLoadError(`Failed to bundle spec's external references: ${message}`);
  }

  return { document: bundled, originalVersion };
}
