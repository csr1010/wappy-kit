import type { GeneratedTool } from "./operations.js";
import { matchesAny } from "./glob.js";

export interface CurateOptions {
  /** Only operations carrying at least one of these tags pass (OR'd with `include`, if either is
   * given at all). Omit both to start from every tool. */
  tags?: string[];
  /** Glob patterns matched against operationId/tool name/tags — OR'd with `tags`. */
  include?: string[];
  /** Glob patterns matched the same way as `include`, but REMOVE a match even if `tags`/`include`
   * kept it — always applied, regardless of whether `tags`/`include` were given. */
  exclude?: string[];
  /** Caps the final tool count. When there are more surviving candidates than this, the ones kept
   * are ranked by lexical relevance to the combined `tags`+`include` keywords (§8 T7.7
   * "auto-suggest ranking (lexical)") — falling back to preferring readOnly (GET/HEAD) operations
   * when neither `tags` nor `include` was given (no keywords to rank against). */
  max?: number;
}

export interface CurateDrop {
  tool: GeneratedTool;
  reason: string;
}

export interface CurateResult {
  tools: GeneratedTool[];
  /** Every tool NOT in `tools`, with why — covers tags/include/exclude filtering AND the max cap. */
  dropped: CurateDrop[];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Fraction of the query's distinct words found in the tool's own text (name/description/tags) — the
 * same dependency-free lexical-overlap approach as harness's recall-budget.ts/tool-selector.ts. */
function lexicalRelevance(queryWords: Set<string>, tool: GeneratedTool): number {
  // Only called from the max-cap ranking branch below, which is itself gated on keywords.size > 0.
  const toolWords = new Set(tokenize([tool.name, tool.description, ...(tool.operation.tags ?? [])].join(" ")));
  let matches = 0;
  for (const w of queryWords) if (toolWords.has(w)) matches++;
  return matches / queryWords.size;
}

function candidateStrings(tool: GeneratedTool): string[] {
  const tags = tool.operation.tags ?? [];
  return [tool.operationId, tool.name, ...tags].filter((v): v is string => Boolean(v));
}

/**
 * Narrows a generated-tool set down to a curated subset (§8 T7.7, "curate/allow-list at install...
 * so a huge spec doesn't overload the model"): `tags`/`include` (OR'd together) select which
 * operations are candidates at all (omit both to start from everything); `exclude` always removes a
 * match; `max` caps the final count via lexical ranking against the tags/include keywords (or a
 * readOnly-first fallback when there were no keywords to rank against). Every excluded tool is
 * reported in `dropped` with a human-readable reason — never silently vanishes.
 */
export function curate(tools: GeneratedTool[], opts: CurateOptions = {}): CurateResult {
  const dropped: CurateDrop[] = [];
  const hasInclusionFilter = (opts.tags && opts.tags.length > 0) || (opts.include && opts.include.length > 0);

  let candidates = tools;
  if (hasInclusionFilter) {
    const included: GeneratedTool[] = [];
    for (const tool of tools) {
      const tags = tool.operation.tags ?? [];
      const tagMatch = opts.tags ? tags.some((t) => opts.tags!.includes(t)) : false;
      const includeMatch = opts.include ? candidateStrings(tool).some((c) => matchesAny(opts.include!, c)) : false;
      if (tagMatch || includeMatch) included.push(tool);
      else dropped.push({ tool, reason: "Did not match tags or include filters." });
    }
    candidates = included;
  }

  if (opts.exclude && opts.exclude.length > 0) {
    const kept: GeneratedTool[] = [];
    for (const tool of candidates) {
      if (candidateStrings(tool).some((c) => matchesAny(opts.exclude!, c))) {
        dropped.push({ tool, reason: "Matched an exclude pattern." });
      } else {
        kept.push(tool);
      }
    }
    candidates = kept;
  }

  if (opts.max !== undefined && candidates.length > opts.max) {
    const keywords = new Set(tokenize([...(opts.tags ?? []), ...(opts.include ?? [])].join(" ")));
    const ranked =
      keywords.size > 0
        ? [...candidates].sort((a, b) => lexicalRelevance(keywords, b) - lexicalRelevance(keywords, a))
        : [...candidates].sort((a, b) => Number(b.method.toUpperCase() === "GET" || b.method.toUpperCase() === "HEAD") - Number(a.method.toUpperCase() === "GET" || a.method.toUpperCase() === "HEAD"));
    const kept = ranked.slice(0, opts.max);
    const keptNames = new Set(kept.map((t) => t.name));
    for (const tool of ranked) {
      if (!keptNames.has(tool.name)) dropped.push({ tool, reason: `Exceeded the max (${opts.max}) tool cap.` });
    }
    candidates = kept;
  }

  return { tools: candidates, dropped };
}
