import type { Clock } from "@wappy_ai/core";
import type { Knowledge } from "@wappy_ai/harness";
import type { Action, ActionResult } from "@wappy_ai/productivity";
import type { TemplateId, Task } from "@wappy_ai/productivity";
import { isExpired, refreshAccessToken, type FetchImpl, type GoogleOAuthConfig } from "./oauth.js";
import type { GoogleTokenStore } from "./token-store.js";
import { fetchEvents } from "./calendar.js";
import { searchEmails } from "./gmail.js";

const NOT_CONNECTED = "That needs Google connected first — open your task list and tap \"Connect Google\" to enable this.";

export interface CreateGoogleActionsOptions {
  config: GoogleOAuthConfig;
  tokenStore: GoogleTokenStore;
  clock: Clock;
  /** Optional: ingests real fetched content so a plain-text follow-up ("what's my next meeting")
   * gets a grounded answer via harness's existing RAG pipeline instead of nothing to go on. Omit to
   * skip ingestion entirely — the digest reply still works, just isn't queryable afterward. */
  knowledge?: Knowledge;
  fetchImpl?: FetchImpl;
}

/** A fresh access token, refreshing first if needed — every action below starts here. Returns
 * `undefined` (never throws) when nothing is connected yet, so callers fall back to the honest stub. */
async function getFreshAccessToken(opts: CreateGoogleActionsOptions): Promise<string | undefined> {
  const tokens = await opts.tokenStore.get();
  if (!tokens) return undefined;
  const now = opts.clock.now();
  if (!isExpired(tokens, now)) return tokens.accessToken;
  const refreshed = await refreshAccessToken(opts.config, tokens.refreshToken, now, opts.fetchImpl);
  await opts.tokenStore.set(refreshed);
  return refreshed.accessToken;
}

function dayRange(clock: Clock, offsetDays: number): { start: number; end: number; label: string } {
  const now = new Date(clock.now());
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime(), label: offsetDays === 0 ? "today" : "tomorrow" };
}

const dailyMeetings = (opts: CreateGoogleActionsOptions): Action => async (task: Task): Promise<ActionResult> => {
  const accessToken = await getFreshAccessToken(opts);
  if (!accessToken) return { ok: true, message: NOT_CONNECTED };

  const { start, end, label } = dayRange(opts.clock, 1); // "tomorrow", matching the template's own wording
  const events = await fetchEvents(accessToken, start, end, opts.fetchImpl);

  if (events.length === 0) {
    return { ok: true, message: `You have no meetings ${label}.` };
  }
  const lines = events.map((e, i) => `${i + 1}. ${e.summary} — ${new Date(e.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${e.location ? ` (${e.location})` : ""}`);
  const message = [`Your meetings ${label}:`, ...lines].join("\n");

  if (opts.knowledge) await opts.knowledge.ingest(`calendar:${task.contactId}:${label}`, message);
  return { ok: true, message };
};

const summarizeEmails = (opts: CreateGoogleActionsOptions): Action => async (task: Task): Promise<ActionResult> => {
  const accessToken = await getFreshAccessToken(opts);
  if (!accessToken) return { ok: true, message: NOT_CONNECTED };

  const emails = await searchEmails(accessToken, "in:inbox is:unread", 5, opts.fetchImpl);
  if (emails.length === 0) return { ok: true, message: "No unread emails." };

  const lines = emails.map((e, i) => `${i + 1}. ${e.subject} — from ${e.from}\n   ${e.snippet}`);
  const message = ["Your recent emails:", ...lines].join("\n");

  if (opts.knowledge) await opts.knowledge.ingest(`email-digest:${task.contactId}`, message);
  return { ok: true, message };
};

const findEmails = (opts: CreateGoogleActionsOptions): Action => async (task: Task): Promise<ActionResult> => {
  const accessToken = await getFreshAccessToken(opts);
  if (!accessToken) return { ok: true, message: NOT_CONNECTED };

  const query = task.placeholders.query ?? "";
  if (!query) return { ok: true, message: "This task is missing a search query." };
  const emails = await searchEmails(accessToken, query, 5, opts.fetchImpl);
  if (emails.length === 0) return { ok: true, message: `No emails found matching "${query}".` };

  const lines = emails.map((e, i) => `${i + 1}. ${e.subject} — from ${e.from}\n   ${e.snippet}`);
  const message = [`Emails matching "${query}":`, ...lines].join("\n");

  if (opts.knowledge) await opts.knowledge.ingest(`email-search:${task.contactId}:${query}`, message);
  return { ok: true, message };
};

/**
 * Real actions for the 3 Google-backed templates, replacing `@wappy_ai/productivity`'s honest stubs
 * — merge the result into `DEFAULT_ACTIONS` (spread this object over it) before passing to
 * `createTaskRunner`. Never throws on "not connected": returns the same honest stub text the
 * productivity package's own default does, so nothing breaks if this gets wired in before a real
 * Google connection exists. Real API failures (token refresh failing, a 5xx from Google) DO throw,
 * which is correct — that's exactly what the runner's own retry-then-notify logic (Phase 2) is for,
 * left completely untouched here.
 */
export function createGoogleActions(opts: CreateGoogleActionsOptions): Partial<Record<TemplateId, Action>> {
  return {
    daily_meetings: dailyMeetings(opts),
    summarize_emails: summarizeEmails(opts),
    find_emails: findEmails(opts),
  };
}
