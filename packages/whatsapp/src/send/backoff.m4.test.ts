import { describe, expect, test } from "vitest";
import { computeBackoffMs, parseRetryAfterMs } from "./backoff.js";

describe("computeBackoffMs", () => {
  test("doubles per attempt (with no jitter, random pinned to 0.5)", () => {
    const noJitter = () => 0.5; // (0.5*2 - 1) = 0 -> exact exponential value
    expect(computeBackoffMs(1, { baseMs: 100, jitterRatio: 0.2 }, noJitter)).toBe(100);
    expect(computeBackoffMs(2, { baseMs: 100, jitterRatio: 0.2 }, noJitter)).toBe(200);
    expect(computeBackoffMs(3, { baseMs: 100, jitterRatio: 0.2 }, noJitter)).toBe(400);
  });

  test("caps at maxMs", () => {
    const noJitter = () => 0.5;
    expect(computeBackoffMs(20, { baseMs: 100, maxMs: 1000, jitterRatio: 0 }, noJitter)).toBe(1000);
  });

  test("jitter moves the delay within +/- jitterRatio of the exponential value", () => {
    const high = computeBackoffMs(2, { baseMs: 100, jitterRatio: 0.2 }, () => 1); // max jitter
    const low = computeBackoffMs(2, { baseMs: 100, jitterRatio: 0.2 }, () => 0); // min jitter
    expect(high).toBe(240); // 200 + 20%
    expect(low).toBe(160); // 200 - 20%
  });

  test("never returns a negative delay", () => {
    expect(computeBackoffMs(1, { baseMs: 10, jitterRatio: 5 }, () => 0)).toBeGreaterThanOrEqual(0);
  });

  test("uses sensible defaults when no options given", () => {
    expect(computeBackoffMs(1)).toBeGreaterThan(0);
  });
});

describe("parseRetryAfterMs", () => {
  test("parses a numeric seconds value", () => {
    expect(parseRetryAfterMs("5", 1000)).toBe(5000);
  });

  test("parses an HTTP-date value relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("2026-01-01T00:00:10Z", now)).toBe(10_000);
  });

  test("a past HTTP-date clamps to 0, not negative", () => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    expect(parseRetryAfterMs("2026-01-01T00:00:00Z", now)).toBe(0);
  });

  test("missing or unparseable header returns undefined", () => {
    expect(parseRetryAfterMs(undefined, 0)).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-value-or-date", 0)).toBeUndefined();
  });
});
