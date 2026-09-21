import type { SmartMessage } from "@wappy/core";

/**
 * Single source of truth for WhatsApp's string-length limits (§6.1). Structural limits (max 3
 * buttons, max 10 list rows) are already rejected by SmartMessageSchema at the core layer (M1) —
 * only length limits reach here, since the schema deliberately allows them through for us to
 * truncate rather than reject (see docs/CONTRACTS.md).
 */
export const LIMITS = {
  buttonTitle: 20,
  listButtonText: 20,
  listRowTitle: 24,
  listRowDescription: 72,
  ctaButtonText: 20,
  bodyText: 4096,
} as const;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncates to at most `maxLength` graphemes (visual characters) — never splits an emoji/surrogate pair/combining mark. */
export function truncateGraphemeSafe(text: string, maxLength: number): string {
  const graphemes = [...segmenter.segment(text)].map((s) => s.segment);
  if (graphemes.length <= maxLength) return text;
  if (maxLength <= 1) return graphemes.slice(0, Math.max(maxLength, 0)).join("");
  return graphemes.slice(0, maxLength - 1).join("") + "…";
}

export interface ConstrainedMessage {
  message: SmartMessage;
  /** Field paths that were truncated, e.g. "buttons[0].title" — for tracing/logging, never thrown. */
  truncated: string[];
}

/** Applies every length limit, truncating (never rejecting) whatever's over. */
export function applyConstraints(message: SmartMessage): ConstrainedMessage {
  const truncated: string[] = [];
  const clip = (path: string, text: string, max: number): string => {
    const t = truncateGraphemeSafe(text, max);
    if (t !== text) truncated.push(path);
    return t;
  };

  const out: SmartMessage = { ...message };

  if (out.text) out.text = clip("text", out.text, LIMITS.bodyText);

  if (out.buttons) {
    out.buttons = out.buttons.map((b, i) => ({ ...b, title: clip(`buttons[${i}].title`, b.title, LIMITS.buttonTitle) }));
  }

  if (out.list) {
    out.list = {
      buttonText: clip("list.buttonText", out.list.buttonText, LIMITS.listButtonText),
      sections: out.list.sections.map((section, si) => ({
        ...section,
        rows: section.rows.map((row, ri) => ({
          ...row,
          title: clip(`list.sections[${si}].rows[${ri}].title`, row.title, LIMITS.listRowTitle),
          description: row.description ? clip(`list.sections[${si}].rows[${ri}].description`, row.description, LIMITS.listRowDescription) : row.description,
        })),
      })),
    };
  }

  if (out.cta) out.cta = { ...out.cta, text: clip("cta.text", out.cta.text, LIMITS.ctaButtonText) };

  return { message: out, truncated };
}
