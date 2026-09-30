import type { Clock } from "@wappy_ai/core";
import { isExpired, refreshAccessToken, type FetchImpl, type GoogleOAuthConfig } from "./oauth.js";
import type { GoogleTokenStore } from "./token-store.js";
import { fetchEvents } from "./calendar.js";
import { searchEmails } from "./gmail.js";

/**
 * v3 redesign — generic, parameterized read functions matching `@wappy_ai/productivity`'s
 * `createGoogleAssistant`'s `ConnectorContext` shape. Direct feedback: "whatever we are going to
 * build it should work for anything that user might ask" — a fixed no-arg fetch (top-5-unread,
 * next-30-days) can't do that; these take real query/time-range parameters so an LLM tool-calling
 * loop (harness's own `createVercelModel`, which already runs one internally) can construct the
 * right request per message, using Gmail's and Calendar's own real query syntax rather than a
 * hand-rolled filtering layer.
 */

export interface CreateGoogleContextOptions {
  config: GoogleOAuthConfig;
  tokenStore: GoogleTokenStore;
  clock: Clock;
  fetchImpl?: FetchImpl;
}

export interface GmailSearchArgs {
  /** Gmail's own search syntax, e.g. `"after:2026/09/27 before:2026/09/29 is:unread from:jane@x.com"`.
   * Omit for the default: unread inbox mail. */
  query?: string;
  /** Default 5, hard-capped at 10 — each result costs a follow-up API call (gmail.ts's own doc
   * comment), so this stays bounded regardless of what's requested. */
  maxResults?: number;
}

export interface CalendarSearchArgs {
  /** ISO 8601 timestamps — both omitted defaults to the next 30 days from now. */
  timeMinISO?: string;
  timeMaxISO?: string;
  /** Calendar's own free-text search across title/description/location/attendees. */
  query?: string;
}

const NOT_CONNECTED_GMAIL = "Gmail isn't connected yet — the person running this bot needs to tap \"Connect Google\" on the task list page.";
const NOT_CONNECTED_CALENDAR = "Calendar isn't connected yet — the person running this bot needs to tap \"Connect Google\" on the task list page.";

/** A fresh access token, refreshing first if needed. Returns `undefined` (never throws) when nothing
 * is connected yet, so callers fall back to an honest "not connected" string instead of erroring. */
async function getFreshAccessToken(opts: CreateGoogleContextOptions): Promise<string | undefined> {
  const tokens = await opts.tokenStore.get();
  if (!tokens) return undefined;
  const now = opts.clock.now();
  if (!isExpired(tokens, now)) return tokens.accessToken;
  const refreshed = await refreshAccessToken(opts.config, tokens.refreshToken, now, opts.fetchImpl);
  await opts.tokenStore.set(refreshed);
  return refreshed.accessToken;
}

/** Real, parameterized Gmail search — `args.query` is passed straight through as Gmail's own search
 * syntax; the caller (an LLM tool call) constructs it from whatever was actually asked, this
 * function doesn't interpret or re-filter it. */
export function createGmailSearchFn(opts: CreateGoogleContextOptions): (args: GmailSearchArgs) => Promise<string> {
  return async (args) => {
    const accessToken = await getFreshAccessToken(opts);
    if (!accessToken) return NOT_CONNECTED_GMAIL;
    const query = args.query?.trim() || "in:inbox is:unread";
    const maxResults = Math.min(Math.max(args.maxResults ?? 5, 1), 10);
    const emails = await searchEmails(accessToken, query, maxResults, opts.fetchImpl);
    if (emails.length === 0) return `No emails matching "${query}".`;
    return emails.map((e, i) => `${i + 1}. ${e.subject} — from ${e.from}\n   ${e.snippet}`).join("\n");
  };
}

/** Real, parameterized Calendar search — `args.timeMinISO`/`timeMaxISO` set the window (default the
 * next 30 days when both are omitted), `args.query` passed straight through as Calendar's own
 * free-text search. Same "the caller constructs the real query, this function just executes it"
 * shape as Gmail's. */
export function createCalendarSearchFn(opts: CreateGoogleContextOptions): (args: CalendarSearchArgs) => Promise<string> {
  return async (args) => {
    const accessToken = await getFreshAccessToken(opts);
    if (!accessToken) return NOT_CONNECTED_CALENDAR;
    const now = opts.clock.now();
    const start = args.timeMinISO ? Date.parse(args.timeMinISO) : now;
    const end = args.timeMaxISO ? Date.parse(args.timeMaxISO) : now + 30 * 24 * 60 * 60 * 1000;
    const events = await fetchEvents(accessToken, start, end, args.query, opts.fetchImpl);
    if (events.length === 0) return "No matching events in that range.";
    return events.map((e, i) => `${i + 1}. ${e.summary} — ${new Date(e.start).toLocaleString()}${e.location ? ` (${e.location})` : ""}`).join("\n");
  };
}
