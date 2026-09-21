import type { Turn } from "@wappy/core";
import type { ContextBudget } from "./context-budget.js";

export interface AssembleInput {
  system: string;
  skillFragments?: string[];
  /** Rendered tool schema blocks (one per tool), already stringified by the caller. */
  toolSchemas?: string[];
  summary?: string;
  /** Relevance-ranked, most relevant first (T6.4) — truncation drops from the end, keeping the best. */
  recalledSnippets?: string[];
  /** Chronologically ordered, oldest first — truncation drops from the start, keeping the most recent. */
  recentTurns?: Turn[];
  userMessage: string;
}

type OptionalSection = "skillFragments" | "toolSchemas" | "summary" | "recalledSnippets" | "recentTurns";

/** Each optional section's share of the total prompt budget, so one section can't dominate
 * regardless of how large the model's window is. Remaining budget goes to system + user message
 * (mandatory, never capped/dropped — §10). */
const DEFAULT_SECTION_FRACTIONS: Record<OptionalSection, number> = {
  skillFragments: 0.1,
  toolSchemas: 0.2,
  summary: 0.05,
  recalledSnippets: 0.1,
  recentTurns: 0.3,
};

/** Fixed assembly order (stable prefix — prompt-cache friendly) is ALSO the order sections are
 * dropped in reverse when even individually-capped sections don't fit the total budget: lowest
 * priority (recalledSnippets) drops first, recentTurns last (before the mandatory sections). */
const DROP_PRIORITY: OptionalSection[] = ["recalledSnippets", "toolSchemas", "summary", "skillFragments", "recentTurns"];

export interface AssembleResult {
  prompt: string;
  /** Estimated tokens per section that survived (T6.9 — also drives tests). */
  usage: Record<string, number>;
  /** Section names dropped entirely because even after their own cap, the total didn't fit. */
  dropped: string[];
}

function truncateToTokens(text: string, maxTokens: number, budget: ContextBudget): string {
  if (maxTokens <= 0) return "";
  if (budget.estimator.estimate(text) <= maxTokens) return text;
  // Binary search the longest prefix whose estimate fits — correct for any estimator, not just chars/3.5.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (budget.estimator.estimate(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** Drops items from the end of `items` (after rendering each with `render`) until the joined text's
 * estimate fits `maxTokens`. Used for recalledSnippets/skillFragments (best-first, drop the tail). */
function capArrayFromEnd<T>(items: T[], render: (t: T) => string, maxTokens: number, budget: ContextBudget, join: string): string {
  let kept = items;
  while (kept.length > 0 && budget.estimator.estimate(kept.map(render).join(join)) > maxTokens) {
    kept = kept.slice(0, -1);
  }
  return kept.map(render).join(join);
}

/** Drops items from the START of `items` until the joined text fits — used for recentTurns
 * (chronological, oldest-first), keeping the most recent turns. */
function capArrayFromStart<T>(items: T[], render: (t: T) => string, maxTokens: number, budget: ContextBudget, join: string): string {
  let kept = items;
  while (kept.length > 0 && budget.estimator.estimate(kept.map(render).join(join)) > maxTokens) {
    kept = kept.slice(1);
  }
  return kept.map(render).join(join);
}

function renderTurn(t: Turn): string {
  return `${t.role}: ${t.text ?? "(no text)"}`;
}

/**
 * Deterministic prompt assembler (§10 "prompt/token overflow -> tool retrieval + curation"):
 * fixed order system -> skill fragments -> tool schemas -> summary -> recalled snippets -> recent
 * turns -> user message. Each optional section gets its own token-budget share; if the total still
 * doesn't fit after per-section capping, whole sections are dropped lowest-priority-first — system
 * and the user message are never capped or dropped.
 */
export function assemblePrompt(input: AssembleInput, budget: ContextBudget): AssembleResult {
  const sections = new Map<OptionalSection, string>();
  const cap = (name: OptionalSection): number => Math.floor(budget.promptBudget * DEFAULT_SECTION_FRACTIONS[name]);

  if (input.skillFragments && input.skillFragments.length > 0) {
    sections.set("skillFragments", capArrayFromEnd(input.skillFragments, (s) => s, cap("skillFragments"), budget, "\n\n"));
  }
  if (input.toolSchemas && input.toolSchemas.length > 0) {
    sections.set("toolSchemas", capArrayFromEnd(input.toolSchemas, (s) => s, cap("toolSchemas"), budget, "\n"));
  }
  if (input.summary) {
    sections.set("summary", truncateToTokens(input.summary, cap("summary"), budget));
  }
  if (input.recalledSnippets && input.recalledSnippets.length > 0) {
    sections.set("recalledSnippets", capArrayFromEnd(input.recalledSnippets, (s) => s, cap("recalledSnippets"), budget, "\n"));
  }
  if (input.recentTurns && input.recentTurns.length > 0) {
    sections.set("recentTurns", capArrayFromStart(input.recentTurns, renderTurn, cap("recentTurns"), budget, "\n"));
  }

  // A section whose input had content but capped down to "" (its own cap was too tight to fit even
  // a minimal amount) is just as dropped as one removed below for total-budget pressure — record it
  // the same way, so T6.9's tracing can't distinguish "never provided" from "provided but too big".
  const dropped: string[] = [];
  for (const [name, text] of sections) {
    if (!text) {
      sections.delete(name);
      dropped.push(name);
    }
  }

  const render = (): string =>
    [
      input.system,
      sections.get("skillFragments"),
      sections.get("toolSchemas"),
      sections.get("summary"),
      sections.get("recalledSnippets"),
      sections.get("recentTurns"),
      input.userMessage,
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");

  for (const name of DROP_PRIORITY) {
    if (budget.estimator.estimate(render()) <= budget.promptBudget) break;
    if (sections.delete(name)) dropped.push(name);
  }

  const usage: Record<string, number> = { system: budget.estimator.estimate(input.system), userMessage: budget.estimator.estimate(input.userMessage) };
  for (const [name, text] of sections) usage[name] = budget.estimator.estimate(text);

  return { prompt: render(), usage, dropped };
}
