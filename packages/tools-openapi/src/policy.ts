import type { GeneratedTool } from "./operations.js";

export interface PolicyOptions {
  /** Glob patterns (only `*`/`?` wildcards) matched against an operation's operationId, derived
   * tool name, AND every tag — any single match includes the operation. Default: unset = allow all
   * (subject to the DELETE gate below). */
  allowList?: string[];
  /** Explicit opt-in required for a DELETE operation to be included at all, even if it matches
   * `allowList` — default false (DELETE excluded by default; §8 T7.6 "explicit opt-in for DELETE"). */
  allowDestructive?: boolean;
}

export interface PolicyDecision {
  included: boolean;
  /** Never mutates external state — true only for GET/HEAD (§8 T7.6 "readOnly default"). */
  readOnly: boolean;
  /** Requires operator/user confirmation before executing — true for every non-GET/HEAD method. */
  confirmBefore: boolean;
  /** Present when `included` is false — why this operation was excluded. */
  reason?: string;
}

function escapeRegExpLiteral(text: string): string {
  // Escapes every regex-special char, INCLUDING * and ? — so the next step can reliably find the
  // (now-escaped) wildcard markers and turn only those into their regex equivalents, rather than
  // leaving a bare "*"/"?" to be misinterpreted as a real regex quantifier on the preceding char.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob matcher (`*` = any run of chars, `?` = one char) — no dependency, since this is a
 * handful of characters' worth of translation, not spec parsing. */
function globToRegExp(pattern: string): RegExp {
  const translated = escapeRegExpLiteral(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${translated}$`);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}

/**
 * Decides whether a generated tool is exposed at all, and its readOnly/confirmBefore flags (§8 T7.6):
 * readOnly is true only for GET/HEAD; confirmBefore is true for every other method; a DELETE
 * operation is excluded unless `allowDestructive` is explicitly set; an `allowList` (operationId, the
 * generated tool name, or any tag — each glob-matchable) further restricts which operations are
 * exposed when provided.
 */
export function applyPolicy(tool: GeneratedTool, opts: PolicyOptions = {}): PolicyDecision {
  const method = tool.method.toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";
  const confirmBefore = !readOnly;

  if (method === "DELETE" && !opts.allowDestructive) {
    return { included: false, readOnly, confirmBefore, reason: "DELETE operations are excluded by default — pass allowDestructive: true to opt in explicitly." };
  }

  if (opts.allowList && opts.allowList.length > 0) {
    const tags = tool.operation.tags ?? [];
    const candidates = [tool.operationId, tool.name, ...tags].filter((v): v is string => Boolean(v));
    const matched = candidates.some((c) => matchesAny(opts.allowList!, c));
    if (!matched) {
      return { included: false, readOnly, confirmBefore, reason: `Not in allowList (checked: ${candidates.join(", ") || "operationId/name/tags all missing"}).` };
    }
  }

  return { included: true, readOnly, confirmBefore };
}
