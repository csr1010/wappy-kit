import { describe, expect, test } from "vitest";
import { boundToolResult } from "./bound-tool-result.js";

describe("boundToolResult — within limits", () => {
  test("small data passes through untouched, truncated:false", () => {
    const result = boundToolResult({ orderId: "8842", status: "shipped" }, { maxBytes: 10_000, maxArrayItems: 20 });
    expect(result).toEqual({ truncated: false, totalBytes: expect.any(Number), shown: { orderId: "8842", status: "shipped" } });
  });

  test("a small array within maxArrayItems passes through untouched", () => {
    const items = [1, 2, 3];
    const result = boundToolResult(items, { maxBytes: 10_000, maxArrayItems: 20 });
    expect(result).toEqual({ truncated: false, totalBytes: expect.any(Number), shown: items });
  });
});

describe("boundToolResult — array paging", () => {
  test("an array exceeding maxArrayItems is limited, marked truncated, with a hint", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const result = boundToolResult(items, { maxBytes: 1_000_000, maxArrayItems: 10 });
    expect(result.truncated).toBe(true);
    expect(Array.isArray(result.shown)).toBe(true);
    expect((result.shown as unknown[]).length).toBe(10);
    expect(result.hint).toContain("10");
    expect(result.hint).toContain("500");
  });

  test("array paging also respects maxBytes even if item count is small", () => {
    const items = Array.from({ length: 5 }, () => "x".repeat(1000));
    const result = boundToolResult(items, { maxBytes: 500, maxArrayItems: 20 });
    expect(result.truncated).toBe(true);
    expect((result.shown as unknown[]).length).toBeLessThan(5);
  });
});

describe("boundToolResult — string truncation", () => {
  test("a string exceeding maxBytes is truncated with a hint, never passed through whole", () => {
    const huge = "x".repeat(5_000_000); // 5 MB
    const result = boundToolResult(huge, { maxBytes: 1000, maxArrayItems: 20 });
    expect(result.truncated).toBe(true);
    expect(typeof result.shown).toBe("string");
    expect((result.shown as string).length).toBeLessThan(huge.length);
    expect(result.totalBytes).toBe(5_000_000);
    expect(result.hint).toBeTruthy();
  });

  test("a string within maxBytes is untouched", () => {
    const result = boundToolResult("short text", { maxBytes: 1000, maxArrayItems: 20 });
    expect(result).toEqual({ truncated: false, totalBytes: 10, shown: "short text" });
  });
});

describe("boundToolResult — oversized non-array object", () => {
  test("an object whose JSON exceeds maxBytes is stringified and truncated, never passed through raw", () => {
    const big = { data: "x".repeat(5_000_000) };
    const result = boundToolResult(big, { maxBytes: 1000, maxArrayItems: 20 });
    expect(result.truncated).toBe(true);
    expect(typeof result.shown).toBe("string");
    expect((result.shown as string).length).toBeLessThanOrEqual(1000 + 50); // truncated string + hint slack
  });
});

describe("boundToolResult — non-JSON-serializable values", () => {
  test("undefined (JSON.stringify returns undefined, not a string) is handled without crashing", () => {
    const result = boundToolResult(undefined, { maxBytes: 1000, maxArrayItems: 20 });
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(0);
    expect(result.shown).toBeUndefined();
  });
});

describe("boundToolResult — never passes raw megabytes to the model", () => {
  test("no matter the input shape, the JSON size of the output never exceeds roughly maxBytes", () => {
    const huge = { items: Array.from({ length: 10_000 }, (_, i) => ({ id: i, blob: "y".repeat(500) })) };
    const result = boundToolResult(huge, { maxBytes: 2000, maxArrayItems: 5 });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.shown).length).toBeLessThan(JSON.stringify(huge).length);
  });
});
