export interface InboundTextLimits {
  /** Above this, the text is truncated (with a visible notice) before being processed normally. */
  maxChars: number;
  /** Above this, the whole message is too large to meaningfully process — refuse politely instead
   * of attempting a truncated reply that would likely miss the point entirely. */
  refuseChars: number;
}

export const DEFAULT_INBOUND_TEXT_LIMITS: InboundTextLimits = { maxChars: 4_000, refuseChars: 20_000 };

export interface BoundedInboundText {
  text: string;
  truncated: boolean;
  refuse: boolean;
}

/** Bounds an oversized inbound message/caption (§10 "prompt/token overflow"): truncates with an
 * honest notice below `refuseChars`, flags for a polite refusal above it. */
export function boundInboundText(text: string, limits: InboundTextLimits = DEFAULT_INBOUND_TEXT_LIMITS): BoundedInboundText {
  if (text.length > limits.refuseChars) return { text, truncated: false, refuse: true };
  if (text.length > limits.maxChars) {
    return { text: `${text.slice(0, limits.maxChars)}\n\n[message truncated — it was too long to process in full]`, truncated: true, refuse: false };
  }
  return { text, truncated: false, refuse: false };
}
