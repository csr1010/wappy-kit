import { describe, expect, test, vi } from "vitest";
import type { Clock } from "@wappy_ai/core";
import { createCalendarSearchFn, createGmailSearchFn, type CreateGoogleContextOptions } from "./actions.js";
import { createGoogleTokenStore } from "./token-store.js";
import type { GoogleOAuthConfig } from "./oauth.js";

/** v3 (plan pivot: generic, parameterized Gmail/Calendar search functions — no more fixed no-arg
 * fetch — matching @wappy_ai/productivity's createGoogleAssistant tool-calling design. */

const config: GoogleOAuthConfig = { clientId: "c", clientSecret: "s", redirectUri: "http://localhost/google/callback" };

function fakeClock(now: number): Clock {
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
}

describe("createGmailSearchFn / createCalendarSearchFn — not connected yet", () => {
  test("both return an honest 'not connected' string when no tokens are stored, never throw", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const gmail = createGmailSearchFn({ config, tokenStore, clock: fakeClock(0) });
    const calendar = createCalendarSearchFn({ config, tokenStore, clock: fakeClock(0) });
    expect(await gmail({})).toContain("Connect Google");
    expect(await calendar({})).toContain("Connect Google");
  });
});

describe("createCalendarSearchFn", () => {
  async function connectedOptions(fetchImpl: CreateGoogleContextOptions["fetchImpl"]): Promise<CreateGoogleContextOptions> {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    return { config, tokenStore, clock: fakeClock(0), fetchImpl };
  }

  test("formats a real fetched event list into a readable list", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [{ summary: "Standup", start: { dateTime: "2026-09-28T09:00:00Z" } }] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    expect(await calendar({})).toContain("Standup");
  });

  test("an empty result is an honest 'no matching events' string, not silence or an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    expect(await calendar({})).toContain("No matching events");
  });

  test("both timeMinISO/timeMaxISO omitted defaults to the next 30 days from the clock", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    await calendar({});
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    const spanMs = new Date(url.searchParams.get("timeMax")!).getTime() - new Date(url.searchParams.get("timeMin")!).getTime();
    expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("explicit timeMinISO/timeMaxISO are used instead of the default", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    await calendar({ timeMinISO: "2026-10-01T00:00:00.000Z", timeMaxISO: "2026-10-02T00:00:00.000Z" });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get("timeMin")).toBe("2026-10-01T00:00:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-10-02T00:00:00.000Z");
  });

  test("a query arg passes through as Calendar's own free-text search", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    await calendar({ query: "offsite" });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get("q")).toBe("offsite");
  });

  test("a token past expiry is refreshed before the Calendar call fires", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "old-at", refreshToken: "rt", expiresAt: 500 }); // already expired at clock=1000
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: true, status: 200, json: async () => ({ access_token: "new-at", expires_in: 3600 }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    });
    const calendar = createCalendarSearchFn({ config, tokenStore, clock: fakeClock(1000), fetchImpl });
    await calendar({});
    const calendarCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("calendar/v3"));
    expect((calendarCall![1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer new-at");
    expect((await tokenStore.get())!.accessToken).toBe("new-at");
  });

  test("a still-valid token is NOT refreshed (no call to the token endpoint at all)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarSearchFn(await connectedOptions(fetchImpl));
    await calendar({});
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("oauth2.googleapis.com"))).toBe(false);
  });
});

describe("createGmailSearchFn", () => {
  test("no query given defaults to unread inbox mail", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const gmail = createGmailSearchFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    const text = await gmail({});
    expect(text).toContain("No emails matching");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("is%3Aunread");
  });

  test("an explicit query is passed straight through as real Gmail search syntax", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const gmail = createGmailSearchFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    await gmail({ query: "after:2026/09/27 is:unread" });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("after%3A2026%2F09%2F27");
  });

  test("maxResults is capped at 10 even if a larger value is requested", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const gmail = createGmailSearchFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    await gmail({ maxResults: 999 });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("maxResults=10");
  });

  test("formats subject/from/snippet for each fetched email", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }] }) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ snippet: "See you there", payload: { headers: [{ name: "Subject", value: "Team offsite" }, { name: "From", value: "jane@example.com" }] } }),
      } as unknown as Response;
    });
    const gmail = createGmailSearchFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    const text = await gmail({});
    expect(text).toContain("Team offsite");
    expect(text).toContain("jane@example.com");
    expect(text).toContain("See you there");
  });
});
