import { describe, expect, test, vi } from "vitest";
import type { Clock } from "@wappy_ai/core";
import { createCalendarContextFn, createGmailContextFn, type CreateGoogleContextOptions } from "./actions.js";
import { createGoogleTokenStore } from "./token-store.js";
import type { GoogleOAuthConfig } from "./oauth.js";

const config: GoogleOAuthConfig = { clientId: "c", clientSecret: "s", redirectUri: "http://localhost/google/callback" };

function fakeClock(now: number): Clock {
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
}

describe("createGmailContextFn / createCalendarContextFn — not connected yet", () => {
  test("both return an honest 'not connected' string when no tokens are stored, never throw", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const gmail = createGmailContextFn({ config, tokenStore, clock: fakeClock(0) });
    const calendar = createCalendarContextFn({ config, tokenStore, clock: fakeClock(0) });
    expect(await gmail()).toContain("Connect Google");
    expect(await calendar()).toContain("Connect Google");
  });
});

describe("createCalendarContextFn", () => {
  async function connectedOptions(fetchImpl: CreateGoogleContextOptions["fetchImpl"]): Promise<CreateGoogleContextOptions> {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    return { config, tokenStore, clock: fakeClock(0), fetchImpl };
  }

  test("formats a real fetched event list into a readable list", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [{ summary: "Standup", start: { dateTime: "2026-09-28T09:00:00Z" } }] }) }) as unknown as Response);
    const calendar = createCalendarContextFn(await connectedOptions(fetchImpl));
    const text = await calendar();
    expect(text).toContain("Standup");
  });

  test("an empty calendar is an honest 'no upcoming events' string, not silence or an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarContextFn(await connectedOptions(fetchImpl));
    expect(await calendar()).toContain("No upcoming events");
  });

  test("fetches a 7-day window from the clock's current time", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarContextFn(await connectedOptions(fetchImpl));
    await calendar();
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    const spanMs = new Date(url.searchParams.get("timeMax")!).getTime() - new Date(url.searchParams.get("timeMin")!).getTime();
    expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("a token past expiry is refreshed before the Calendar call fires", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "old-at", refreshToken: "rt", expiresAt: 500 }); // already expired at clock=1000
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: true, status: 200, json: async () => ({ access_token: "new-at", expires_in: 3600 }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    });
    const calendar = createCalendarContextFn({ config, tokenStore, clock: fakeClock(1000), fetchImpl });
    await calendar();
    const calendarCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("calendar/v3"));
    expect((calendarCall![1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer new-at");
    expect((await tokenStore.get())!.accessToken).toBe("new-at");
  });

  test("a still-valid token is NOT refreshed (no call to the token endpoint at all)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const calendar = createCalendarContextFn(await connectedOptions(fetchImpl));
    await calendar();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("oauth2.googleapis.com"))).toBe(false);
  });
});

describe("createGmailContextFn", () => {
  test("fetches unread inbox mail (no query needed — filtering happens later, in router.ts's compose step)", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const gmail = createGmailContextFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    const text = await gmail();
    expect(text).toBe("No unread emails.");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("is%3Aunread");
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
    const gmail = createGmailContextFn({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    const text = await gmail();
    expect(text).toContain("Team offsite");
    expect(text).toContain("jane@example.com");
    expect(text).toContain("See you there");
  });
});
