import { describe, expect, test, vi } from "vitest";
import { systemClock } from "@wappy/core";
import { sendSmartMessage, type SendDeps } from "./orchestrator.js";
import { createSessionWindowTracker } from "../session-window.js";

// Regression, found by hand-testing a real WhatsApp product list: a model that puts everything
// into list rows (reasonable — that's what the rows are for) and skips its own intro `text` used
// to make every real send fail (Meta rejects empty interactive.body.text with a 400), which then
// silently degraded to the numbered-text fallback ladder. The rich message looked broken; it was
// actually never delivered. This test proves the FIRST (rich) send attempt now succeeds, not that
// the fallback ladder correctly catches a failure.

function deps(fetchImpl: typeof fetch): SendDeps {
  const sessionWindow = createSessionWindowTracker();
  sessionWindow.recordInbound("wa1", systemClock.now());
  return {
    graphApiBaseUrl: "https://graph.facebook.com/v21.0",
    phoneNumberId: "123",
    accessToken: "tok",
    fetchImpl,
    clock: systemClock,
    sessionWindow,
  };
}

describe("sendSmartMessage — a rich message with no model-supplied text is accepted on the first attempt", () => {
  test("a list with no text succeeds without falling back to numbered plain text", async () => {
    const seenBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      seenBodies.push(body);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    });

    const result = await sendSmartMessage(
      { list: { buttonText: "View", sections: [{ rows: [{ id: "p1", title: "The Minimal Snowboard", description: "$885.95" }] }] } },
      "wa1",
      deps(fetchImpl as unknown as typeof fetch),
    );

    expect(result.status).toBe("sent"); // not "fellBack" — the rich send itself worked
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second (fallback) attempt was needed
    expect((seenBodies[0] as { interactive: { body: { text: string } } }).interactive.body.text).not.toBe("");
  });

  test("buttons with no text also succeed on the first attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 }));
    const result = await sendSmartMessage({ buttons: [{ id: "yes", title: "Yes" }, { id: "no", title: "No" }] }, "wa1", deps(fetchImpl as unknown as typeof fetch));
    expect(result.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a genuine send failure (unrelated to the empty-text bug) still falls back, and the fallback text includes row descriptions and any cta link", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ error: { message: "simulated failure" } }), { status: 500 });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.3" }] }), { status: 200 });
    });
    const result = await sendSmartMessage(
      { cta: { text: "Shop now", url: "https://example.com" }, list: { buttonText: "View", sections: [{ rows: [{ id: "p1", title: "Snowboard", description: "$885.95" }] }] } },
      "wa1",
      { ...deps(fetchImpl as unknown as typeof fetch), maxAttempts: 1 }, // no internal retry — one failure should reach the fallback ladder immediately
    );
    expect(result.status).toBe("fellBack");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string) as { text: { body: string } };
    expect(fallbackBody.text.body).toContain("$885.95");
    expect(fallbackBody.text.body).toContain("Shop now: https://example.com");
  });
});
