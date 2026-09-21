import { describe, expect, test } from "vitest";
import { sendWithRetry } from "./http-send.js";

function fakeClock() {
  const sleeps: number[] = [];
  return { now: () => 0, sleep: async (ms: number) => void sleeps.push(ms), sleeps };
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers })) as typeof fetch;
}

const baseDeps = { graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t" };

describe("sendWithRetry", () => {
  test("succeeds on the first attempt, no sleep", async () => {
    const clock = fakeClock();
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl: respond(200, { messages: [{ id: "wamid.1" }] }), clock });
    expect(result).toEqual({ ok: true, messageId: "wamid.1" });
    expect(clock.sleeps).toEqual([]);
  });

  test("a non-retryable error (e.g. 131026) fails on the first attempt, no retry", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 131026, message: "undeliverable" } }), { status: 400 });
    }) as typeof fetch;
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl, clock });
    expect(result).toEqual({ ok: false, reason: "meta 131026: undeliverable", metaCode: 131026, httpStatus: 400 });
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("429 -> backoff -> success on a later attempt", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response(JSON.stringify({ error: { code: 130429, message: "rate limited" } }), { status: 429 });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl, clock, maxAttempts: 5 });
    expect(result).toEqual({ ok: true, messageId: "wamid.ok" });
    expect(calls).toBe(3);
    expect(clock.sleeps).toHaveLength(2); // slept before attempts 2 and 3
  });

  test("5xx retried up to maxAttempts, then reports failed", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("server error", { status: 503 });
    }) as typeof fetch;
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl, clock, maxAttempts: 3 });
    expect(result).toEqual({ ok: false, reason: "http 503", httpStatus: 503 });
    expect(calls).toBe(3);
    expect(clock.sleeps).toHaveLength(2); // no sleep after the final (non-retried) attempt
  });

  test("honors a Retry-After header over the computed backoff", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { code: 130429, message: "x" } }), { status: 429, headers: { "retry-after": "7" } });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
    }) as typeof fetch;
    await sendWithRetry({}, { ...baseDeps, fetchImpl, clock, maxAttempts: 3 });
    expect(clock.sleeps).toEqual([7000]);
  });

  test("a network error (fetch throws) is retried like any other transient failure", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl, clock, maxAttempts: 3 });
    expect(result).toEqual({ ok: true, messageId: "wamid.ok" });
    expect(calls).toBe(2);
  });

  test("a network error on every attempt exhausts retries and reports the last error", async () => {
    const clock = fakeClock();
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const result = await sendWithRetry({}, { ...baseDeps, fetchImpl, clock, maxAttempts: 2 });
    expect(result).toEqual({ ok: false, reason: "network error: ECONNRESET" });
  });

  test("a non-JSON success body still returns ok with no messageId", async () => {
    const clock = fakeClock();
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    expect(await sendWithRetry({}, { ...baseDeps, fetchImpl, clock })).toEqual({ ok: true, messageId: undefined });
  });
});
