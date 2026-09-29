import type { Clock } from "@wappy_ai/core";
import { isExpired, refreshAccessToken, type FetchImpl, type GoogleOAuthConfig } from "./oauth.js";
import type { GoogleTokenStore } from "./token-store.js";
import { fetchEvents } from "./calendar.js";
import { searchEmails } from "./gmail.js";

/**
 * v2 redesign: `@wappy_ai/productivity`'s `createTaskRouter` takes plain `() => Promise<string>`
 * connector functions (its `ConnectorContext.gmail`/`calendar`), not a templateId-keyed action map —
 * this package no longer depends on `@wappy_ai/productivity` at all, just `@wappy_ai/core`. A
 * generated project's `index.ts` wires these two functions in directly.
 */

export interface CreateGoogleContextOptions {
  config: GoogleOAuthConfig;
  tokenStore: GoogleTokenStore;
  clock: Clock;
  fetchImpl?: FetchImpl;
}

const NOT_CONNECTED_GMAIL = "Gmail isn't connected yet — the person running this bot needs to tap \"Connect Google\" on their task list.";
const NOT_CONNECTED_CALENDAR = "Calendar isn't connected yet — the person running this bot needs to tap \"Connect Google\" on their task list.";

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

/**
 * Returns a fixed default set — the top 5 unread emails — formatted as plain text; `router.ts`'s
 * compose step is the one that actually filters/tailors this down to a task's specific instructions
 * (e.g. "from jane@example.com"), so this deliberately doesn't take a query: keeping the model's own
 * reasoning over real fetched data as the one place filtering happens, not a hand-built Gmail query
 * per task.
 */
export function createGmailContextFn(opts: CreateGoogleContextOptions): () => Promise<string> {
  return async () => {
    const accessToken = await getFreshAccessToken(opts);
    if (!accessToken) return NOT_CONNECTED_GMAIL;
    const emails = await searchEmails(accessToken, "in:inbox is:unread", 5, opts.fetchImpl);
    if (emails.length === 0) return "No unread emails.";
    return emails.map((e, i) => `${i + 1}. ${e.subject} — from ${e.from}\n   ${e.snippet}`).join("\n");
  };
}

/** Same shape for Calendar — fetches the next 7 days' events (a fixed default window), formatted as
 * plain text for the compose step to filter/summarize per the matched task's instructions. */
export function createCalendarContextFn(opts: CreateGoogleContextOptions): () => Promise<string> {
  return async () => {
    const accessToken = await getFreshAccessToken(opts);
    if (!accessToken) return NOT_CONNECTED_CALENDAR;
    const now = opts.clock.now();
    const events = await fetchEvents(accessToken, now, now + 7 * 24 * 60 * 60 * 1000, opts.fetchImpl);
    if (events.length === 0) return "No upcoming events in the next 7 days.";
    return events.map((e, i) => `${i + 1}. ${e.summary} — ${new Date(e.start).toLocaleString()}${e.location ? ` (${e.location})` : ""}`).join("\n");
  };
}
