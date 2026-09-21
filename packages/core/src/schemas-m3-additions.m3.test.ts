import { describe, expect, test } from "vitest";
import { InboundMediaSchema, InboundMessageSchema } from "./schemas.js";

// New optional fields added during M3 (code review caught: interactive reply id and location
// lat/long were being silently dropped by @wappy/whatsapp's parser). schemas.m1.test.ts is
// protected by B2 once tagged, so these live in their own m3-tagged file.

describe("InboundMessage.selectionId", () => {
  test("accepted alongside text (title) and defaults to absent", () => {
    const withSelection = InboundMessageSchema.safeParse({ id: "1", contactId: "c1", channel: "whatsapp", text: "Store hours", selectionId: "store_hours", timestamp: 0 });
    expect(withSelection.success).toBe(true);
    expect(withSelection.success && withSelection.data.selectionId).toBe("store_hours");

    const without = InboundMessageSchema.safeParse({ id: "1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0 });
    expect(without.success && without.data.selectionId).toBeUndefined();
  });
});

describe("InboundMedia.latitude/longitude", () => {
  test("a location carries coordinates", () => {
    const r = InboundMediaSchema.safeParse({ kind: "location", latitude: 37.4419, longitude: -122.143 });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ kind: "location", latitude: 37.4419, longitude: -122.143 });
  });

  test("non-location media doesn't require coordinates", () => {
    expect(InboundMediaSchema.safeParse({ kind: "image", url: "x" }).success).toBe(true);
  });
});
