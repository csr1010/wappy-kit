// Common filler words excluded so they can't contribute false-positive relevance between an
// otherwise-unrelated query and document (e.g. both merely containing "the" or "my").
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "has", "have",
  "how", "i", "if", "in", "is", "it", "my", "of", "on", "or", "s", "t", "the", "this", "to", "was",
  "what", "when", "where", "will", "with", "you", "your",
]);

/** Tool/identifier names are conventionally camelCase (getOrderStatus) — split before lowercasing
 * so "order" and "status" are individually matchable, not glued into one unsearchable token. */
function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function tokenize(text: string): string[] {
  return (splitCamelCase(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** BM25 (Okapi) scores for `queryTerms` against each of `docs` (already tokenized). Standard k1=1.5, b=0.75.
 * Shared between `tool-selector.ts` (T6.5, ranking Tools) and `knowledge.ts` (T8.3, ranking chunks) —
 * the scoring math doesn't care what a "document" represents. */
export function bm25Scores(queryTerms: string[], docs: string[][]): number[] {
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
