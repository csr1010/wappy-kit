import type { Clock, Memory, Model, Turn } from "@wappy/core";

const SUMMARY_KIND = "wappy.summary";

export interface WindowHistoryOptions {
  model: Model;
  memory: Memory;
  contactId: string;
  /** Full, chronologically ordered history (oldest first) — as loaded from Memory. */
  history: Turn[];
  /** Turns kept verbatim; anything older than this, past the last summary, gets summarized. */
  maxRecentTurns: number;
  clock: Clock;
}

export interface WindowedHistory {
  summary?: string;
  recentTurns: Turn[];
}

function isSummaryTurn(t: Turn): boolean {
  return t.meta?.kind === SUMMARY_KIND;
}

function fallbackSummary(turns: Turn[]): string {
  return `(${turns.length} earlier message${turns.length === 1 ? "" : "s"} — summarization unavailable, showing only recent history)`;
}

/**
 * History windowing + rolling summarization (§10 "prompt/token overflow -> tool retrieval +
 * curation"): once unsummarized history exceeds `maxRecentTurns`, the oldest excess is summarized
 * via a cheap model call and the summary persisted to Memory as a turn (so a later call reusing the
 * same history sees it and doesn't re-summarize already-covered turns). On summarizer failure,
 * degrades to plain truncation rather than losing the reply (§10).
 */
export async function windowHistory(opts: WindowHistoryOptions): Promise<WindowedHistory> {
  const summaryTurns = opts.history.filter(isSummaryTurn);
  const latestSummary = summaryTurns[summaryTurns.length - 1];
  const summarizedThroughId = latestSummary?.meta?.throughTurnId as string | undefined;

  const resumeIndex = summarizedThroughId ? opts.history.findIndex((t) => t.id === summarizedThroughId) : -1;
  const unsummarized = opts.history.slice(resumeIndex + 1).filter((t) => !isSummaryTurn(t));

  if (unsummarized.length <= opts.maxRecentTurns) {
    return { summary: latestSummary?.text, recentTurns: unsummarized };
  }

  const toSummarize = unsummarized.slice(0, unsummarized.length - opts.maxRecentTurns);
  const recentTurns = unsummarized.slice(unsummarized.length - opts.maxRecentTurns);
  const lastSummarizedTurn = toSummarize[toSummarize.length - 1]!;

  const prompt = [
    latestSummary?.text ? `Prior summary of even earlier conversation:\n${latestSummary.text}\n` : "",
    "Summarize the following conversation turns concisely, preserving anything a later reply might need to reference:",
    ...toSummarize.map((t) => `${t.role}: ${t.text ?? "(no text)"}`),
  ]
    .filter(Boolean)
    .join("\n");

  let summaryText: string;
  try {
    const result = await opts.model.generate({ prompt });
    summaryText = result.text || fallbackSummary(toSummarize);
  } catch {
    summaryText = fallbackSummary(toSummarize);
  }

  const summaryTurnId = `summary:${lastSummarizedTurn.id}`;
  await opts.memory.append({
    id: summaryTurnId,
    contactId: opts.contactId,
    role: "system",
    text: summaryText,
    timestamp: opts.clock.now(),
    meta: { kind: SUMMARY_KIND, throughTurnId: lastSummarizedTurn.id },
  });

  return { summary: summaryText, recentTurns };
}
