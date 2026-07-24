export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the computed delay randomized either direction, e.g. 0.2 = ±20%. */
  jitterRatio?: number;
}

/** Exponential backoff with jitter (§6.2 "rate limits + exponential backoff on 429/5xx"). attempt is 1-based. */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const jitterRatio = opts.jitterRatio ?? 0.2;
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  const jitter = exp * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** Parses a Retry-After header (seconds, or an HTTP-date) into a millisecond delay from `now`. */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return undefined;
}
