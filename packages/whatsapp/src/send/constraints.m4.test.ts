import { describe, expect, test } from "vitest";
import { applyConstraints, LIMITS, truncateGraphemeSafe } from "./constraints.js";

describe("truncateGraphemeSafe", () => {
  test("leaves short text alone", () => {
    expect(truncateGraphemeSafe("hi", 20)).toBe("hi");
  });

  test("truncates at exactly the boundary (no ellipsis needed)", () => {
    expect(truncateGraphemeSafe("12345", 5)).toBe("12345");
  });

  test("truncates over-length text with an ellipsis, total length === maxLength", () => {
    const r = truncateGraphemeSafe("a".repeat(30), 20);
    expect([...r].length <= 20).toBe(true);
    expect(r.endsWith("…")).toBe(true);
    expect(r).toBe("a".repeat(19) + "…");
  });

  test("never splits an emoji (surrogate pair / ZWJ sequence) even when it's the truncation boundary", () => {
    const familyEmoji = "👨‍👩‍👧‍👦"; // one grapheme, multiple code points joined by ZWJ (U+200D)
    const text = "hi" + familyEmoji + "bye"; // graphemes: h, i, <family>, b, y, e (6 total)
    const r = truncateGraphemeSafe(text, 3); // boundary lands exactly on the emoji
    expect(r).toBe("hi…"); // the emoji is dropped whole (with the ellipsis taking its slot), never half-emitted
    expect(r).not.toMatch(/‍/); // no dangling zero-width-joiner from a split sequence
    expect(truncateGraphemeSafe(text, 30)).toBe(text); // and it survives completely intact when not truncated
  });

  test("CJK and RTL text truncate by grapheme, not by UTF-16 code unit", () => {
    const cjk = "こんにちは世界"; // 7 graphemes
    expect(truncateGraphemeSafe(cjk, 3)).toBe("こん…");
    expect(truncateGraphemeSafe(cjk, 7)).toBe(cjk);
  });

  test("maxLength of 0 or 1 doesn't crash and returns something no longer than requested", () => {
    expect(truncateGraphemeSafe("hello", 0)).toBe("");
    expect(truncateGraphemeSafe("hello", 1)).toBe("h");
  });
});

describe("applyConstraints", () => {
  test("a message within all limits is unchanged", () => {
    const message = { text: "hi", buttons: [{ id: "b1", title: "Store hours" }] };
    const { message: out, truncated } = applyConstraints(message);
    expect(out).toEqual(message);
    expect(truncated).toEqual([]);
  });

  test("an over-length button title is truncated and reported", () => {
    const { message, truncated } = applyConstraints({ text: "hi", buttons: [{ id: "b1", title: "x".repeat(30) }] });
    expect(message.buttons?.[0]?.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
    expect(truncated).toEqual(["buttons[0].title"]);
  });

  test("boundary: a title at exactly the limit is untouched", () => {
    const title = "x".repeat(LIMITS.buttonTitle);
    const { truncated } = applyConstraints({ text: "hi", buttons: [{ id: "b1", title }] });
    expect(truncated).toEqual([]);
  });

  test("boundary: a title one over the limit is truncated", () => {
    const title = "x".repeat(LIMITS.buttonTitle + 1);
    const { truncated } = applyConstraints({ text: "hi", buttons: [{ id: "b1", title }] });
    expect(truncated).toEqual(["buttons[0].title"]);
  });

  test("list row title/description and list buttonText are all truncated independently", () => {
    const { message, truncated } = applyConstraints({
      text: "hi",
      list: {
        buttonText: "x".repeat(30),
        sections: [{ rows: [{ id: "r1", title: "y".repeat(30), description: "z".repeat(80) }] }],
      },
    });
    expect(message.list?.buttonText.length).toBeLessThanOrEqual(LIMITS.listButtonText);
    expect(message.list?.sections[0]?.rows[0]?.title.length).toBeLessThanOrEqual(LIMITS.listRowTitle);
    expect(message.list?.sections[0]?.rows[0]?.description?.length).toBeLessThanOrEqual(LIMITS.listRowDescription);
    expect(truncated).toEqual(["list.buttonText", "list.sections[0].rows[0].title", "list.sections[0].rows[0].description"]);
  });

  test("a list row with no description is left as-is (not truncated to an empty string)", () => {
    const { message, truncated } = applyConstraints({ text: "hi", list: { buttonText: "Pick", sections: [{ rows: [{ id: "r1", title: "Order" }] }] } });
    expect(message.list?.sections[0]?.rows[0]?.description).toBeUndefined();
    expect(truncated).toEqual([]);
  });

  test("an over-length CTA button text is truncated", () => {
    const { message, truncated } = applyConstraints({ text: "hi", cta: { text: "x".repeat(30), url: "https://example.com" } });
    expect(message.cta?.text.length).toBeLessThanOrEqual(LIMITS.ctaButtonText);
    expect(truncated).toEqual(["cta.text"]);
  });

  test("an over-length body is truncated", () => {
    const { message, truncated } = applyConstraints({ text: "x".repeat(LIMITS.bodyText + 100) });
    expect(message.text?.length).toBeLessThanOrEqual(LIMITS.bodyText);
    expect(truncated).toEqual(["text"]);
  });

  test("media-only message (no text/buttons/list/cta) passes through untouched", () => {
    const message = { media: { kind: "image" as const, url: "https://example.com/a.png" } };
    const { message: out, truncated } = applyConstraints(message);
    expect(out).toEqual(message);
    expect(truncated).toEqual([]);
  });
});
