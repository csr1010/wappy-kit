export type ErrorAction = "retry" | "fallback" | "template" | "drop" | "alert";

interface ErrorMapEntry {
  action: ErrorAction;
  /** All entries are "verify against Meta docs" until confirmed against a live account (§10). */
  note: string;
}

// developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes — verify each of these
// against that page (and live traffic) before relying on it in production; the codes below are
// the commonly-documented ones, mapped to the action that best matches their stated meaning.
const META_ERROR_CODES: Record<number, ErrorMapEntry> = {
  0: { action: "retry", note: "unknown/generic error — verify" },
  1: { action: "retry", note: "internal server error — verify" },
  100: { action: "drop", note: "invalid parameter — our own request is malformed, retrying won't help — verify" },
  130429: { action: "retry", note: "rate limit hit — verify" },
  131026: { action: "fallback", note: "message undeliverable to this recipient — verify" },
  131047: { action: "template", note: "re-engagement message outside the 24h window — verify" },
  131051: { action: "fallback", note: "unsupported message type for this recipient/number — verify" },
  131056: { action: "retry", note: "pair rate limit (same business/recipient pair) — verify" },
  133010: { action: "alert", note: "account not registered — needs operator attention — verify" },
  190: { action: "alert", note: "access token invalid/expired — needs operator attention — verify" },
  368: { action: "alert", note: "account temporarily blocked — needs operator attention — verify" },
};

/** Maps a Meta error (numeric `code`, if any) + the HTTP status to an action; unknown codes fall back to a safe default from the HTTP status alone. */
export function mapMetaErrorCode(code: number | undefined, httpStatus: number): ErrorAction {
  if (code !== undefined) {
    const known = META_ERROR_CODES[code];
    if (known) return known.action;
  }
  if (httpStatus === 429) return "retry";
  if (httpStatus >= 500) return "retry";
  if (httpStatus >= 400) return "fallback";
  return "retry";
}
