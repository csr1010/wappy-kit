import { describe, expect, test } from "vitest";
import { renderSmartMessage } from "./render.js";

const TO = "15550002222";

describe("renderSmartMessage — header (M12, verified against the real Cloud API)", () => {
  test("text header alongside buttons", () => {
    const payload = renderSmartMessage({ header: { type: "text", text: "New arrivals" }, buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: { header: unknown } };
    expect(payload.interactive.header).toEqual({ type: "text", text: "New arrivals" });
  });

  test("image header alongside a list, rendered as {image: {link}}", () => {
    const payload = renderSmartMessage(
      { header: { type: "image", url: "https://example.com/a.jpg" }, list: { buttonText: "View", sections: [{ rows: [{ id: "r", title: "R" }] }] } },
      TO,
    ) as { interactive: { header: unknown } };
    expect(payload.interactive.header).toEqual({ type: "image", image: { link: "https://example.com/a.jpg" } });
  });

  test("video header alongside a cta", () => {
    const payload = renderSmartMessage({ header: { type: "video", url: "https://example.com/a.mp4" }, cta: { text: "Shop", url: "https://example.com" } }, TO) as { interactive: { header: unknown } };
    expect(payload.interactive.header).toEqual({ type: "video", video: { link: "https://example.com/a.mp4" } });
  });

  test("document header includes filename when given, omits it when not", () => {
    const withName = renderSmartMessage({ header: { type: "document", url: "https://example.com/a.pdf", filename: "brochure.pdf" }, buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: { header: unknown } };
    expect(withName.interactive.header).toEqual({ type: "document", document: { link: "https://example.com/a.pdf", filename: "brochure.pdf" } });

    const withoutName = renderSmartMessage({ header: { type: "document", url: "https://example.com/a.pdf" }, buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: { header: unknown } };
    expect(withoutName.interactive.header).toEqual({ type: "document", document: { link: "https://example.com/a.pdf" } });
  });

  test("no header set: no header key in the payload at all (not header: undefined)", () => {
    const payload = renderSmartMessage({ buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: Record<string, unknown> };
    expect("header" in payload.interactive).toBe(false);
  });
});
