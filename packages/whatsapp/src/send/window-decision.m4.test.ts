import { describe, expect, test } from "vitest";
import { decideSendPath } from "./window-decision.js";

describe("decideSendPath", () => {
  test("open window -> freeform", () => {
    expect(decideSendPath({ windowOpen: true })).toEqual({ kind: "freeform" });
  });

  test("closed window with a configured template -> template", () => {
    expect(decideSendPath({ windowOpen: false, defaultTemplateName: "order_update" })).toEqual({ kind: "template", templateName: "order_update" });
  });

  test("closed window with no template configured -> queued with an honest reason, never silently dropped", () => {
    const result = decideSendPath({ windowOpen: false });
    expect(result.kind).toBe("queued");
    expect((result as { reason: string }).reason).toMatch(/window/i);
  });
});
