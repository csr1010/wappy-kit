import { describe, expect, test, vi } from "vitest";
import { fetchEvents } from "./calendar.js";

function fakeFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => response }) as unknown as Response);
}

describe("fetchEvents", () => {
  test("calls the real Calendar API endpoint with a bearer token and the given time range", async () => {
    const fetchImpl = fakeFetch({ items: [] });
    await fetchEvents("token-abc", 1_000_000, 2_000_000, undefined, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("googleapis.com/calendar/v3/calendars/primary/events");
    expect(String(url)).toContain("singleEvents=true");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer token-abc");
  });

  test("passes a query through as Calendar's own free-text search (q param)", async () => {
    const fetchImpl = fakeFetch({ items: [] });
    await fetchEvents("token-abc", 0, 1, "offsite", fetchImpl);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("q=offsite");
  });

  test("no query given means no q param at all, not an empty one", async () => {
    const fetchImpl = fakeFetch({ items: [] });
    await fetchEvents("token-abc", 0, 1, undefined, fetchImpl);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain("q=");
  });

  test("maps Calendar API events into the simpler CalendarEvent shape", async () => {
    const fetchImpl = fakeFetch({
      items: [
        { summary: "Team sync", start: { dateTime: "2026-09-28T15:00:00Z" }, location: "Room 2" },
        { summary: "No location event", start: { date: "2026-09-28" } },
        { start: { dateTime: "2026-09-28T18:00:00Z" } }, // missing summary
      ],
    });
    const events = await fetchEvents("token", 0, 1, undefined, fetchImpl);
    expect(events).toEqual([
      { summary: "Team sync", start: "2026-09-28T15:00:00Z", location: "Room 2" },
      { summary: "No location event", start: "2026-09-28" },
      { summary: "(untitled event)", start: "2026-09-28T18:00:00Z" },
    ]);
  });

  test("throws with Google's own error message on a non-ok response", async () => {
    const fetchImpl = fakeFetch({ error: { message: "Invalid Credentials" } }, false, 401);
    await expect(fetchEvents("bad-token", 0, 1, undefined, fetchImpl)).rejects.toThrow(/Invalid Credentials/);
  });
});
