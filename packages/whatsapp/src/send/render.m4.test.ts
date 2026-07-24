import { describe, expect, test } from "vitest";
import type { SmartMessage } from "@wappy/core";
import { renderReaction, renderSmartMessage } from "./render.js";

const TO = "15550002222";

describe("renderSmartMessage", () => {
  test("plain text", () => {
    expect(renderSmartMessage({ text: "*bold* and _italic_" }, TO)).toEqual({
      messaging_product: "whatsapp",
      to: TO,
      type: "text",
      text: { body: "*bold* and _italic_", preview_url: true },
    });
  });

  test("buttons take priority and render as an interactive button message", () => {
    const payload = renderSmartMessage({ text: "Pick one", buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }, TO);
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Pick one" },
        action: { buttons: [{ type: "reply", reply: { id: "a", title: "A" } }, { type: "reply", reply: { id: "b", title: "B" } }] },
      },
    });
  });

  test("list renders as an interactive list message", () => {
    const payload = renderSmartMessage({ text: "Choose", list: { buttonText: "Open", sections: [{ title: "Section", rows: [{ id: "r1", title: "Row", description: "Desc" }] }] } }, TO);
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Choose" },
        action: { button: "Open", sections: [{ title: "Section", rows: [{ id: "r1", title: "Row", description: "Desc" }] }] },
      },
    });
  });

  test("cta renders as an interactive cta_url message", () => {
    const payload = renderSmartMessage({ text: "Shop now", cta: { text: "Visit store", url: "https://example.com" } }, TO);
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: { type: "cta_url", body: { text: "Shop now" }, action: { name: "cta_url", parameters: { display_text: "Visit store", url: "https://example.com" } } },
    });
  });

  test("image media renders with caption", () => {
    const payload = renderSmartMessage({ media: { kind: "image", url: "https://example.com/a.png", caption: "look" } }, TO);
    expect(payload).toEqual({ messaging_product: "whatsapp", to: TO, type: "image", image: { link: "https://example.com/a.png", caption: "look" } });
  });

  test("document media includes filename", () => {
    const payload = renderSmartMessage({ media: { kind: "document", url: "https://example.com/a.pdf", filename: "invoice.pdf" } }, TO);
    expect(payload).toEqual({ messaging_product: "whatsapp", to: TO, type: "document", document: { link: "https://example.com/a.pdf", filename: "invoice.pdf" } });
  });

  test("voice media maps to the Cloud API's audio type, with no caption (unsupported by Meta for audio)", () => {
    const payload = renderSmartMessage({ media: { kind: "voice", url: "https://example.com/a.ogg", caption: "ignored" } }, TO);
    expect(payload).toEqual({ messaging_product: "whatsapp", to: TO, type: "audio", audio: { link: "https://example.com/a.ogg" } });
  });

  // Corrected (SPEC.md decisions log): Meta HARD-rejects an empty interactive.body.text (confirmed
  // against the real Cloud API: 400 "The parameter interactive.body.text is required."), so
  // defaulting to "" here — this test's own original assertion — made every buttons/list/cta send
  // without model-supplied intro text fail outright, silently degrading to the numbered-text
  // fallback ladder. Plain `text` messages have no such requirement from Meta, so that branch is
  // unchanged. Updated with --allow-test-change per the SPEC entry.
  test("buttons/list/cta default an ABSENT text to a sensible non-empty body (Meta rejects empty); plain text still defaults to an empty string", () => {
    expect((renderSmartMessage({ buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: { body: { text: string } } }).interactive.body.text).toBe("Please choose an option:");
    expect((renderSmartMessage({ list: { buttonText: "x", sections: [{ rows: [{ id: "r", title: "R" }] }] } }, TO) as { interactive: { body: { text: string } } }).interactive.body.text).toBe("Here's what I found:");
    expect((renderSmartMessage({ cta: { text: "x", url: "https://x.com" } }, TO) as { interactive: { body: { text: string } } }).interactive.body.text).toBe("Here's a link that might help:");
    expect((renderSmartMessage({} as SmartMessage, TO) as { text: { body: string } }).text.body).toBe("");
  });

  test("buttons/list/cta with a real model-supplied text use it verbatim, not the default", () => {
    expect((renderSmartMessage({ text: "Pick one:", buttons: [{ id: "a", title: "A" }] }, TO) as { interactive: { body: { text: string } } }).interactive.body.text).toBe("Pick one:");
    expect((renderSmartMessage({ text: "Here's what we've got:", list: { buttonText: "x", sections: [{ rows: [{ id: "r", title: "R" }] }] } }, TO) as { interactive: { body: { text: string } } }).interactive.body.text).toBe("Here's what we've got:");
  });

  test("a quoteId adds a context.message_id to any rendered type", () => {
    const payload = renderSmartMessage({ text: "reply", quoteId: "wamid.original" }, TO);
    expect(payload).toMatchObject({ context: { message_id: "wamid.original" } });
  });

  test("priority order: buttons > list > cta > media > text, even if multiple are present", () => {
    const message = {
      text: "fallback text",
      buttons: [{ id: "a", title: "A" }],
      list: { buttonText: "x", sections: [{ rows: [{ id: "r", title: "R" }] }] },
      cta: { text: "x", url: "https://x.com" },
      media: { kind: "image" as const, url: "https://x.com/a.png" },
    };
    expect((renderSmartMessage(message, TO) as { type: string }).type).toBe("interactive");
    expect((renderSmartMessage(message, TO) as { interactive: { type: string } }).interactive.type).toBe("button");
  });
});

describe("renderReaction", () => {
  test("renders a standalone reaction payload", () => {
    expect(renderReaction(TO, "wamid.original", "👍")).toEqual({ messaging_product: "whatsapp", to: TO, type: "reaction", reaction: { message_id: "wamid.original", emoji: "👍" } });
  });
});
