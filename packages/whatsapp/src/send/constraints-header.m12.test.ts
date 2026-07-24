import { describe, expect, test } from "vitest";
import { applyConstraints, LIMITS } from "./constraints.js";

describe("applyConstraints — header.text truncation (M12, limit confirmed against the real Cloud API)", () => {
  test("a header.text at exactly the limit is untouched, not marked truncated", () => {
    const text = "x".repeat(LIMITS.headerText);
    const { message, truncated } = applyConstraints({ header: { type: "text", text }, buttons: [{ id: "a", title: "A" }] });
    expect(message.header).toEqual({ type: "text", text });
    expect(truncated).not.toContain("header.text");
  });

  test("a header.text one over the limit is truncated with an ellipsis and reported", () => {
    const text = "x".repeat(LIMITS.headerText + 1);
    const { message, truncated } = applyConstraints({ header: { type: "text", text }, buttons: [{ id: "a", title: "A" }] });
    expect(message.header?.type === "text" && message.header.text.length).toBeLessThanOrEqual(LIMITS.headerText);
    expect(truncated).toContain("header.text");
  });

  test("a non-text header (image/video/document) is untouched — no text field to truncate", () => {
    const { message, truncated } = applyConstraints({ header: { type: "image", url: "https://example.com/a.jpg" }, buttons: [{ id: "a", title: "A" }] });
    expect(message.header).toEqual({ type: "image", url: "https://example.com/a.jpg" });
    expect(truncated).not.toContain("header.text");
  });

  test("no header set: nothing to truncate, no crash", () => {
    const { message, truncated } = applyConstraints({ text: "hi" });
    expect(message.header).toBeUndefined();
    expect(truncated).toEqual([]);
  });
});
