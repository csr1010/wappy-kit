import type { Tool } from "@wappy/core";
import { charsPerTokenEstimator, type TokenEstimator } from "./context-budget.js";
import { bm25Scores, tokenize } from "./bm25.js";

export interface ToolSelectorOptions {
  tools: Tool[];
  message: string;
  /** Skill-declared tool names (§17 Skill.tools) — always eligible regardless of lexical relevance. */
  alwaysInclude?: string[];
  /** Bounds K implicitly: tools are added best-first until their combined rendered-schema size
   * would exceed this many tokens. */
  maxTokens: number;
  estimator?: TokenEstimator;
}

function schemaTokenCost(tool: Tool, estimator: TokenEstimator): number {
  return estimator.estimate(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

/**
 * Default runtime `ToolSelector` (§8 "spec-bloat control... tool retrieval at runtime"): lexical
 * BM25 over each tool's name+description, no embeddings required. Skill-declared tools are always
 * eligible (added first, bypassing the relevance filter); the rest are ranked and added best-first
 * until `maxTokens` (their combined schema size) is exhausted. A tool with zero lexical relevance to
 * the message is never surfaced just to fill the budget.
 */
export function selectTools(opts: ToolSelectorOptions): Tool[] {
  const estimator = opts.estimator ?? charsPerTokenEstimator;
  const alwaysNames = new Set(opts.alwaysInclude ?? []);
  const always = opts.tools.filter((t) => alwaysNames.has(t.name));
  const rest = opts.tools.filter((t) => !alwaysNames.has(t.name));

  const queryTerms = tokenize(opts.message);
  const docs = rest.map((t) => tokenize(`${t.name} ${t.description}`));
  const scores = bm25Scores(queryTerms, docs);
  const ranked = rest.map((tool, i) => ({ tool, score: scores[i]! })).sort((a, b) => b.score - a.score);

  const selected: Tool[] = [];
  let used = 0;
  for (const t of always) {
    selected.push(t);
    used += schemaTokenCost(t, estimator);
  }
  for (const { tool, score } of ranked) {
    if (score <= 0) break; // no lexical relevance at all — never surfaced by the default selector
    const cost = schemaTokenCost(tool, estimator);
    if (used + cost > opts.maxTokens) break; // top-K cutoff: stop at the first tool that would overflow the budget
    selected.push(tool);
    used += cost;
  }
  return selected;
}
