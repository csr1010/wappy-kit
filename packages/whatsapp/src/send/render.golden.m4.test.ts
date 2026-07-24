import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { SmartMessage } from "@wappy/core";
import { renderReaction, renderSmartMessage } from "./render.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixturesDir = resolve(repoRoot, "fixtures/whatsapp/outbound");
const golden = (name: string) => JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));

const TO = "15550002222";

describe("outbound golden payloads (B4) — render.ts must keep producing exactly these", () => {
  test.each([
    ["text.json", (): unknown => renderSmartMessage({ text: "Hi! *How* can I help?" }, TO)],
    ["buttons.json", (): unknown => renderSmartMessage({ text: "Pick one", buttons: [{ id: "hours", title: "Store hours" }, { id: "track", title: "Track order" }] }, TO)],
    [
      "list.json",
      (): unknown =>
        renderSmartMessage(
          {
            text: "Choose an option",
            list: {
              buttonText: "Open menu",
              sections: [{ title: "Support", rows: [{ id: "hours", title: "Store hours", description: "See when we're open" }, { id: "track", title: "Track order", description: "Check delivery status" }] }],
            },
          },
          TO,
        ),
    ],
    ["cta.json", (): unknown => renderSmartMessage({ text: "Check out our new collection", cta: { text: "Shop now", url: "https://example.com/shop" } }, TO)],
    ["media-image.json", (): unknown => renderSmartMessage({ media: { kind: "image", url: "https://example.com/receipt.png", caption: "Here's your receipt" } }, TO)],
    ["media-document.json", (): unknown => renderSmartMessage({ media: { kind: "document", url: "https://example.com/invoice.pdf", filename: "invoice.pdf" } }, TO)],
    ["media-voice.json", (): unknown => renderSmartMessage({ media: { kind: "voice", url: "https://example.com/note.ogg" } }, TO)],
    ["quoted-reply.json", (): unknown => renderSmartMessage({ text: "Sure, here's the answer", quoteId: "wamid.original123" } as SmartMessage, TO)],
    ["reaction.json", (): unknown => renderReaction(TO, "wamid.original123", "👍")],
  ] as const)("%s", (fixtureName, render) => {
    expect(render()).toEqual(golden(fixtureName));
  });
});
