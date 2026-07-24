import { describe, expect, test } from "vitest";
import { SmartHeaderSchema, SmartMessageSchema } from "./schemas.js";

// New optional field added during M12 (a WhatsApp interactive message can carry a header —
// image/video/document/text — alongside body + buttons/list/cta; verified against Meta's real
// docs, not assumed). schemas.m1.test.ts is protected by B2 once tagged, so this lives in its own
// m12-tagged file, same pattern as schemas-m3-additions.m3.test.ts.

describe("SmartHeaderSchema", () => {
  test("text header accepts text + optional subText", () => {
    expect(SmartHeaderSchema.safeParse({ type: "text", text: "New arrivals" }).success).toBe(true);
    expect(SmartHeaderSchema.safeParse({ type: "text", text: "New arrivals", subText: "This week only" }).success).toBe(true);
    expect(SmartHeaderSchema.safeParse({ type: "text" }).success).toBe(false); // text required
  });

  test.each(["image", "video", "document"] as const)("%s header accepts a url", (type) => {
    expect(SmartHeaderSchema.safeParse({ type, url: "https://example.com/a" }).success).toBe(true);
    expect(SmartHeaderSchema.safeParse({ type }).success).toBe(false); // url required
  });

  test("document header accepts an optional filename; image/video don't have one", () => {
    expect(SmartHeaderSchema.safeParse({ type: "document", url: "https://example.com/a.pdf", filename: "brochure.pdf" }).success).toBe(true);
  });

  test("an unknown type is rejected", () => {
    expect(SmartHeaderSchema.safeParse({ type: "audio", url: "https://example.com/a" }).success).toBe(false);
  });
});

describe("SmartMessageSchema — header is only valid alongside buttons/list/cta", () => {
  const header = { type: "image", url: "https://example.com/a.jpg" } as const;

  test("header + list is accepted", () => {
    const r = SmartMessageSchema.safeParse({ header, list: { buttonText: "View", sections: [{ rows: [{ id: "r", title: "R" }] }] } });
    expect(r.success).toBe(true);
  });

  test("header + buttons is accepted", () => {
    expect(SmartMessageSchema.safeParse({ header, buttons: [{ id: "a", title: "A" }] }).success).toBe(true);
  });

  test("header + cta is accepted", () => {
    expect(SmartMessageSchema.safeParse({ header, cta: { text: "Shop", url: "https://example.com" } }).success).toBe(true);
  });

  test("header alone (no buttons/list/cta) is REJECTED - Meta's own constraint", () => {
    expect(SmartMessageSchema.safeParse({ header, text: "hi" }).success).toBe(false);
    expect(SmartMessageSchema.safeParse({ header, media: { kind: "image", url: "x" } }).success).toBe(false);
  });

  test("no header at all is unaffected (existing behavior preserved)", () => {
    expect(SmartMessageSchema.safeParse({ text: "hi" }).success).toBe(true);
    expect(SmartMessageSchema.safeParse({ list: { buttonText: "x", sections: [{ rows: [{ id: "r", title: "R" }] }] } }).success).toBe(true);
  });
});
