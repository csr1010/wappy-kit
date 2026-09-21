import { describe, expect, test } from "vitest";
import { boundInboundText } from "./bound-inbound-text.js";

describe("boundInboundText — within limits", () => {
  test("short text passes through untouched", () => {
    const result = boundInboundText("hi there", { maxChars: 100, refuseChars: 1000 });
    expect(result).toEqual({ text: "hi there", truncated: false, refuse: false });
  });
});

describe("boundInboundText — truncation with an honest notice", () => {
  test("text over maxChars (but under refuseChars) is truncated with a visible notice", () => {
    const result = boundInboundText("x".repeat(200), { maxChars: 100, refuseChars: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.refuse).toBe(false);
    expect(result.text.length).toBeGreaterThan(100); // includes the notice, not silently cut
    expect(result.text).toContain("truncated");
  });

  test("the kept portion is exactly maxChars of the original text", () => {
    const original = "a".repeat(50) + "b".repeat(150);
    const result = boundInboundText(original, { maxChars: 50, refuseChars: 1000 });
    expect(result.text.startsWith("a".repeat(50))).toBe(true);
    expect(result.text).not.toContain("b");
  });
});

describe("boundInboundText — extreme size refusal", () => {
  test("text over refuseChars is flagged for refusal, not truncated for processing", () => {
    const result = boundInboundText("x".repeat(50_000), { maxChars: 100, refuseChars: 1000 });
    expect(result.refuse).toBe(true);
  });
});

describe("boundInboundText — boundary values", () => {
  test("exactly at maxChars is not truncated", () => {
    const result = boundInboundText("x".repeat(100), { maxChars: 100, refuseChars: 1000 });
    expect(result.truncated).toBe(false);
  });

  test("exactly at refuseChars is not refused (refuse is strictly-greater-than)", () => {
    const result = boundInboundText("x".repeat(1000), { maxChars: 100, refuseChars: 1000 });
    expect(result.refuse).toBe(false);
    expect(result.truncated).toBe(true);
  });
});
