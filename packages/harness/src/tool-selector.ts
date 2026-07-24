import type { Tool } from "@wappy/core";
import { charsPerTokenEstimator, type TokenEstimator } from "./context-budget.js";

// Common filler words excluded so they can't contribute false-positive relevance between an
// otherwise-unrelated query and tool (e.g. both merely containing "the" or "my").
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "has", "have",
  "how", "i", "if", "in", "is", "it", "my", "of", "on", "or", "s", "t", "the", "this", "to", "was",
  "what", "when", "where", "will", "with", "you", "your",
]);

/** Tool names are conventionally camelCase (getOrderStatus) — split before lowercasing so "order"
 * and "status" are individually matchable, not glued into one unsearchable token. */
function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function tokenize(text: string): string[] {
  return (splitCamelCase(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** BM25 (Okapi) scores for `query` against each of `docs` (already tokenized). Standard k1=1.5, b=0.75. */
function bm25Scores(queryTerms: string[], docs: string[][]): number[] {
  const n = docs.length;
  if (n === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / n;

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  // Only ever called (below) for a term already confirmed present in the current doc, so it's
  // always in docFreq with count >= 1 — no fallback needed.
  const idf = (term: string): number => {
    const df = docFreq.get(term)!;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  const uniqueQueryTerms = [...new Set(queryTerms)];
  return docs.map((doc) => {
    const termFreq = new Map<string, number>();
    for (const term of doc) termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of uniqueQueryTerms) {
      const f = termFreq.get(term) ?? 0;
      if (f === 0) continue;
      score += idf(term) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen)));
    }
    return score;
  });
}

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
