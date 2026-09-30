import type { FetchImpl } from "./oauth.js";

/** Real Google Calendar API v3 — `GET /calendars/primary/events`, documented, stable endpoint. */

export interface CalendarEvent {
  summary: string;
  start: string;
  location?: string;
}

interface CalendarApiEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  location?: string;
}
interface CalendarApiResponse {
  items?: CalendarApiEvent[];
  error?: { message?: string };
}

/** `dayStart`/`dayEnd` are epoch ms — the caller decides the actual range, this function just
 * fetches whatever it's given. `query` (optional) is passed straight through as Calendar API's own
 * free-text `q` search param (title/description/location/attendees) — delegating filtering to
 * Google's own search, not a client-side re-implementation of it. */
export async function fetchEvents(accessToken: string, dayStart: number, dayEnd: number, query?: string, fetchImpl: FetchImpl = fetch): Promise<CalendarEvent[]> {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", new Date(dayStart).toISOString());
  url.searchParams.set("timeMax", new Date(dayEnd).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  if (query) url.searchParams.set("q", query);

  const res = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
  const json = (await res.json()) as CalendarApiResponse;
  if (!res.ok) throw new Error(`Google Calendar API: ${json.error?.message ?? res.status}`);

  return (json.items ?? []).map((item) => ({
    summary: item.summary ?? "(untitled event)",
    start: item.start?.dateTime ?? item.start?.date ?? "",
    ...(item.location ? { location: item.location } : {}),
  }));
}
