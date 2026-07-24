import { describe, expect, test } from "vitest";
import { OUTBOUND_MEDIA_LIMITS, validateOutboundMedia } from "./outbound-media.js";

describe("validateOutboundMedia", () => {
  test("valid image passes (undefined = ok)", () => {
    expect(validateOutboundMedia("image", 1024, "image/jpeg")).toBeUndefined();
  });

  test("oversize is rejected with the limit", () => {
    expect(validateOutboundMedia("image", OUTBOUND_MEDIA_LIMITS.image.maxBytes + 1, "image/jpeg")).toEqual({ kind: "too_large", limitBytes: OUTBOUND_MEDIA_LIMITS.image.maxBytes });
  });

  test("exactly at the limit passes", () => {
    expect(validateOutboundMedia("image", OUTBOUND_MEDIA_LIMITS.image.maxBytes, "image/jpeg")).toBeUndefined();
  });

  test("a disallowed mime type is rejected, listing what's allowed", () => {
    expect(validateOutboundMedia("image", 100, "image/gif")).toEqual({ kind: "mime_not_allowed", mimeType: "image/gif", allowed: OUTBOUND_MEDIA_LIMITS.image.mimeTypes });
  });

  test("document has no mime allow-list — any mime passes as long as size is ok", () => {
    expect(validateOutboundMedia("document", 100, "application/x-anything")).toBeUndefined();
  });

  test("an unknown media kind is rejected clearly", () => {
    expect(validateOutboundMedia("sticker", 100, "image/webp")).toEqual({ kind: "unknown_kind", mediaKind: "sticker" });
  });
});
