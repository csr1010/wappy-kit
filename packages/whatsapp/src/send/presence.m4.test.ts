import { describe, expect, test } from "vitest";
import { renderMarkAsRead } from "./presence.js";

describe("renderMarkAsRead", () => {
  test("marks a message read, no typing indicator by default", () => {
    expect(renderMarkAsRead("wamid.1")).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.1" });
  });

  test("optionally includes a typing indicator", () => {
    expect(renderMarkAsRead("wamid.1", { typingIndicator: true })).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.1",
      typing_indicator: { type: "text" },
    });
  });
});
