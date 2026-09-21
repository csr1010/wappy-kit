import type { Memory } from "@wappy/core";

export interface RecallBudgetOptions {
  memory: Memory;
  contactId: string;
  query: string;
  /** Hard cap on the number of snippets returned. */
  maxSnippets: number;
  /** Minimum lexical relevance (0-1, fraction of query words found in the snippet) required to keep
   * a snippet — below this, it's dropped entirely rather than counted toward maxSnippets. Default 0
   * (no filtering beyond the cap). */
  relevanceFloor?: number;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Fraction of the query's distinct words found in the snippet — a dependency-free relevance proxy
 * (embedding-based scoring is RAG's job, M7/M8). Empty query never matches anything. */
function lexicalRelevance(query: string, text: string): number {
  const queryWords = tokenize(query);
  if (queryWords.size === 0) return 0;
  const textWords = tokenize(text);
  let matches = 0;
  for (const w of queryWords) if (textWords.has(w)) matches++;
  return matches / queryWords.size;
}

/**
 * Wraps Memory.recall() with a snippet count cap and a relevance floor (§10 "prompt/token overflow
 * -> tool retrieval + curation"; T6.2's assembler further caps this by token budget) — never
 * returns more than `maxSnippets`, most relevant first.
 */
export async function recallWithBudget(opts: RecallBudgetOptions): Promise<string[]> {
  const raw = await opts.memory.recall(opts.contactId, opts.query);
  const floor = opts.relevanceFloor ?? 0;
  return raw
    .map((text) => ({ text, score: lexicalRelevance(opts.query, text) }))
    .filter((s) => s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxSnippets)
    .map((s) => s.text);
}
