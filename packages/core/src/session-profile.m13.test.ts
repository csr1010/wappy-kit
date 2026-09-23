import { describe, expect, test } from "vitest";
import { SessionProfileSchema } from "./schemas.js";

/**
 * M13: SessionProfile — a small, structured, per-contact profile (facts + current open thread +
 * a coarser summary), TTL-bound. See docs/milestones/M13.md for the full design.
 */
describe("SessionProfileSchema", () => {
  test("accepts the full shape", () => {
    const r = SessionProfileSchema.safeParse({
      contactId: "c1",
      facts: { name: "Jane", location: "NYC" },
      currentState: "asked which candle size they want (small/medium/large)",
      summary: "Jane is browsing the candle collection.",
      expiresAt: 1_000_000,
    });
    expect(r.success).toBe(true);
  });

  test("currentState and summary are optional; facts may be an empty object", () => {
    const r = SessionProfileSchema.safeParse({ contactId: "c1", facts: {}, expiresAt: 1_000_000 });
    expect(r.success).toBe(true);
  });

  test("rejects a facts map with a non-string value", () => {
    const r = SessionProfileSchema.safeParse({ contactId: "c1", facts: { count: 3 }, expiresAt: 1_000_000 });
    expect(r.success).toBe(false);
  });

  test("rejects a missing expiresAt or contactId", () => {
    expect(SessionProfileSchema.safeParse({ contactId: "c1", facts: {} }).success).toBe(false);
    expect(SessionProfileSchema.safeParse({ facts: {}, expiresAt: 1 }).success).toBe(false);
  });
});
