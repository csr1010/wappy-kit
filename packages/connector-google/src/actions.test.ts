import { describe, expect, test, vi } from "vitest";
import type { Clock } from "@wappy_ai/core";
import type { Knowledge } from "@wappy_ai/harness";
import type { ActionContext, Task } from "@wappy_ai/productivity";
import { createGoogleActions, type CreateGoogleActionsOptions } from "./actions.js";
import { createGoogleTokenStore, type GoogleTokenStore } from "./token-store.js";
import type { GoogleOAuthConfig } from "./oauth.js";

const config: GoogleOAuthConfig = { clientId: "c", clientSecret: "s", redirectUri: "http://localhost/google/callback" };
const ctx: ActionContext = { siblingTasks: [] };

function fakeClock(now: number): Clock {
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
}

function task(templateId: Task["templateId"], placeholders: Record<string, string> = {}): Task {
  return { id: "t1", contactId: "+1555", templateId, title: "t", placeholders, scheduleKind: "dailyAt", scheduleValue: "09:00", status: "on", retryCount: 0, createdAt: 0, updatedAt: 0 };
}

function fakeKnowledge(): Knowledge & { ingested: { sourceId: string; text: string }[] } {
  const ingested: { sourceId: string; text: string }[] = [];
  return {
    ingested,
    async ingest(sourceId, text) {
      ingested.push({ sourceId, text });
      return 1;
    },
    async remove() {},
    async recall() {
      return [];
    },
  };
}

describe("createGoogleActions — not connected yet", () => {
  test("all 3 actions return the same honest stub, ok:true, when no tokens are stored", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    const actions = createGoogleActions({ config, tokenStore, clock: fakeClock(0) });
    for (const templateId of ["daily_meetings", "summarize_emails", "find_emails"] as const) {
      const result = await actions[templateId]!(task(templateId), ctx);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Connect Google");
    }
  });
});

describe("createGoogleActions — daily_meetings", () => {
  async function connectedOptions(fetchImpl: CreateGoogleActionsOptions["fetchImpl"], knowledge?: Knowledge): Promise<CreateGoogleActionsOptions> {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    return { config, tokenStore, clock: fakeClock(0), fetchImpl, knowledge };
  }

  test("formats a real fetched event list into a readable digest", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [{ summary: "Standup", start: { dateTime: "2026-09-28T09:00:00Z" } }] }) }) as unknown as Response);
    const actions = createGoogleActions(await connectedOptions(fetchImpl));
    const result = await actions.daily_meetings!(task("daily_meetings"), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Standup");
    expect(result.message).toContain("tomorrow");
  });

  test("an empty calendar is an honest 'no meetings' reply, not silence or an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const actions = createGoogleActions(await connectedOptions(fetchImpl));
    const result = await actions.daily_meetings!(task("daily_meetings"), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no meetings");
  });

  test("ingests the digest into Knowledge when one is provided, does nothing when it isn't", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [{ summary: "Standup", start: { dateTime: "2026-09-28T09:00:00Z" } }] }) }) as unknown as Response);
    const knowledge = fakeKnowledge();
    const actions = createGoogleActions(await connectedOptions(fetchImpl, knowledge));
    await actions.daily_meetings!(task("daily_meetings"), ctx);
    expect(knowledge.ingested).toHaveLength(1);
    expect(knowledge.ingested[0]!.text).toContain("Standup");
  });

  test("a token past expiry is refreshed before the Calendar call fires", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "old-at", refreshToken: "rt", expiresAt: 500 }); // already expired at clock=1000
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: true, status: 200, json: async () => ({ access_token: "new-at", expires_in: 3600 }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    });
    const actions = createGoogleActions({ config, tokenStore, clock: fakeClock(1000), fetchImpl });
    await actions.daily_meetings!(task("daily_meetings"), ctx);
    const calendarCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("calendar/v3"));
    expect((calendarCall![1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer new-at");
    expect((await tokenStore.get())!.accessToken).toBe("new-at");
  });

  test("a still-valid token is NOT refreshed (no call to the token endpoint at all)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as unknown as Response);
    const actions = createGoogleActions(await connectedOptions(fetchImpl));
    await actions.daily_meetings!(task("daily_meetings"), ctx);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("oauth2.googleapis.com"))).toBe(false);
  });
});

describe("createGoogleActions — find_emails", () => {
  test("uses the task's query placeholder in the search", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const actions = createGoogleActions({ config, tokenStore, clock: fakeClock(0), fetchImpl });
    const result = await actions.find_emails!(task("find_emails", { query: "flight confirmation" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("flight confirmation");
    expect(fetchImpl.mock.calls[0]![0]).toContain("flight+confirmation");
  });

  test("a missing query placeholder is an honest message, not a crash or a full-inbox search", async () => {
    const tokenStore = createGoogleTokenStore({ url: ":memory:" });
    await tokenStore.set({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000_000 });
    const actions = createGoogleActions({ config, tokenStore, clock: fakeClock(0), fetchImpl: vi.fn() });
    const result = await actions.find_emails!(task("find_emails", {}), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("missing a search query");
  });
});
