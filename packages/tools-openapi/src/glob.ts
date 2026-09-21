function escapeRegExpLiteral(text: string): string {
  // Escapes every regex-special char, INCLUDING * and ? — so the next step can reliably find the
  // (now-escaped) wildcard markers and turn only those into their regex equivalents, rather than
  // leaving a bare "*"/"?" to be misinterpreted as a real regex quantifier on the preceding char.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob matcher (`*` = any run of chars, `?` = one char) shared by policy.ts and curate.ts —
 * no dependency, since this is a handful of characters' worth of translation, not spec parsing. */
export function globToRegExp(pattern: string): RegExp {
  const translated = escapeRegExpLiteral(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${translated}$`);
}

export function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}
