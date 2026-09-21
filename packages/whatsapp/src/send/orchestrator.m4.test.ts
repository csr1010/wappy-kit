import { describe, expect, test } from "vitest";
import { replayPendingSends, sendSmartMessage, type SendDeps } from "./orchestrator.js";
import { createSessionWindowTracker } from "../session-window.js";
import { createFallbackOptionsStore } from "./fallback.js";
import { createTemplateRegistry } from "./templates.js";
import { createMemoryOutboundQueue, type OutboundQueue } from "./queue.js";

/** Wraps a real memory queue but makes one named method reject every call, to test queue-error handling. */
function queueThrowingOn(method: keyof OutboundQueue, error: unknown): OutboundQueue {
  const real = createMemoryOutboundQueue();
  return {
    ...real,
    [method]: (async () => {
      throw error;
    }) as never,
  };
}

/** Like a real memory queue, but update() only rejects once the item is no longer "pending" — i.e. the
 * post-send bookkeeping write, not the pre-send "claim" write. */
function queueThrowingOnOutcomeUpdate(error: Error): OutboundQueue {
  const real = createMemoryOutboundQueue();
  return {
    ...real,
    update: async (idempotencyKey, patch, now) => {
      if (patch.status !== "pending") throw error;
      return real.update(idempotencyKey, patch, now);
    },
  };
}

/** Like a real memory queue, but update() rejects only the pre-send "claim as pending" write. */
function queueThrowingOnClaimUpdate(error: Error): OutboundQueue {
  const real = createMemoryOutboundQueue();
  return {
    ...real,
    update: async (idempotencyKey, patch, now) => {
      if (patch.status === "pending") throw error;
      return real.update(idempotencyKey, patch, now);
    },
  };
}

const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };

function baseDeps(overrides: Partial<SendDeps> = {}): SendDeps {
  const sessionWindow = createSessionWindowTracker();
  sessionWindow.recordInbound("c1", 0); // window open by default
  return {
    graphApiBaseUrl: "https://api",
    phoneNumberId: "pn1",
    accessToken: "t",
    fetchImpl: (async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out1" }] }), { status: 200 })) as typeof fetch,
    clock,
    sessionWindow,
    ...overrides,
  };
}

describe("sendSmartMessage — window guard", () => {
  test("closed window, no template configured -> queued, never silently dropped", async () => {
    const deps = baseDeps({ sessionWindow: createSessionWindowTracker() }); // never recorded an inbound -> closed
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result.status).toBe("queued");
    expect(result.reason).toMatch(/window/i);
  });

  test("closed window with a configured template -> sends the template instead", async () => {
    const templateRegistry = createTemplateRegistry();
    templateRegistry.register({ name: "greet", language: "en_US", category: "utility", variables: [] });
    let sentType: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentType = JSON.parse(String(init?.body)).type;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.tmpl1" }] }), { status: 200 });
    }) as typeof fetch;
    const deps = baseDeps({ sessionWindow: createSessionWindowTracker(), templateRegistry, defaultTemplateName: "greet", fetchImpl });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "sent", messageId: "wamid.tmpl1" });
    expect(sentType).toBe("template");
  });

  test("open window -> sends freeform, ignoring any configured template", async () => {
    const deps = baseDeps();
    expect(await sendSmartMessage({ text: "hi" }, "c1", deps)).toEqual({ status: "sent", messageId: "wamid.out1" });
  });

  test("closed window, defaultTemplateName set but no templateRegistry configured -> queued", async () => {
    const deps = baseDeps({ sessionWindow: createSessionWindowTracker(), defaultTemplateName: "greet" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "queued", reason: "window closed and no template registry configured" });
  });

  test("closed window, template render fails (missing variables) -> queued with that error", async () => {
    const templateRegistry = createTemplateRegistry();
    templateRegistry.register({ name: "order_update", language: "en_US", category: "utility", variables: ["orderId"] });
    const deps = baseDeps({ sessionWindow: createSessionWindowTracker(), templateRegistry, defaultTemplateName: "order_update" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "queued", reason: 'template "order_update" is missing variables: orderId' });
  });
});

describe("sendSmartMessage — constraint truncation", () => {
  test("an over-length button title is truncated before rendering, not rejected", async () => {
    let sentTitle = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentTitle = JSON.parse(String(init?.body)).interactive.action.buttons[0].reply.title;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendSmartMessage({ text: "hi", buttons: [{ id: "b1", title: "x".repeat(30) }] }, "c1", baseDeps({ fetchImpl }));
    expect(result.status).toBe("sent");
    expect(sentTitle.length).toBeLessThanOrEqual(20);
  });
});

describe("sendSmartMessage — fallback ladder", () => {
  test("a rejected rich message (buttons) falls back to numbered text and reports fellBack with a reason", async () => {
    let call = 0;
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      call++;
      bodies.push(JSON.parse(String(init?.body)));
      if (call === 1) return new Response(JSON.stringify({ error: { code: 131051, message: "unsupported" } }), { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fallback1" }] }), { status: 200 });
    }) as typeof fetch;
    const fallbackStore = createFallbackOptionsStore();
    const result = await sendSmartMessage({ text: "Pick one", buttons: [{ id: "a", title: "Store hours" }, { id: "b", title: "Track order" }] }, "c1", baseDeps({ fetchImpl, fallbackStore }));
    expect(result).toEqual({ status: "fellBack", messageId: "wamid.fallback1", reason: "meta 131051: unsupported" });
    expect(bodies[1]).toMatchObject({ type: "text", text: { body: "Pick one\n1. Store hours\n2. Track order\nReply with a number (1-2)." } });
    // The offered options are now resolvable from a later plain-text reply.
    expect(fallbackStore.resolve("c1", "2", 0)).toEqual({ number: 2, id: "b", title: "Track order" });
  });

  test("a rejected plain-text message has nowhere to fall back to — reports failed", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 131026, message: "undeliverable" } }), { status: 400 })) as typeof fetch;
    const result = await sendSmartMessage({ text: "hi" }, "c1", baseDeps({ fetchImpl }));
    expect(result).toEqual({ status: "failed", reason: "meta 131026: undeliverable" });
  });

  test("a non-retryable list rejection also falls back to numbered text", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ error: { code: 131051, message: "unsupported" } }), { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fb" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendSmartMessage({ text: "Choose", list: { buttonText: "Open", sections: [{ rows: [{ id: "r1", title: "Row" }] }] } }, "c1", baseDeps({ fetchImpl }));
    expect(result.status).toBe("fellBack");
  });

  test("with a queue, the fallback attempt uses a distinct ':fallback'-suffixed idempotency key from the primary attempt", async () => {
    const queue = createMemoryOutboundQueue();
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ error: { code: 131051, message: "unsupported" } }), { status: 400 });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.fb" }] }), { status: 200 });
    }) as typeof fetch;
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound3" });
    const result = await sendSmartMessage({ text: "Pick", buttons: [{ id: "a", title: "A" }] }, "c1", deps);
    expect(result.status).toBe("fellBack");
    expect(await queue.get("reply-to:wamid.inbound3")).toMatchObject({ status: "failed" });
    expect(await queue.get("reply-to:wamid.inbound3:fallback")).toMatchObject({ status: "sent", metaMessageId: "wamid.fb" });
  });

  test("if the fallback attempt ALSO fails, reports failed with the fallback's reason", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 131026, message: "still undeliverable" } }), { status: 400 })) as typeof fetch;
    const result = await sendSmartMessage({ text: "Pick", buttons: [{ id: "a", title: "A" }] }, "c1", baseDeps({ fetchImpl }));
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/still undeliverable/);
  });
});

describe("sendSmartMessage — outbound media preflight", () => {
  test("an oversize media message fails fast, without ever hitting the send endpoint", async () => {
    let sendCalled = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "50000000" } });
      sendCalled = true;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendSmartMessage({ media: { kind: "image", url: "https://x.com/a.png" } }, "c1", baseDeps({ fetchImpl }));
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/exceeds/);
    expect(sendCalled).toBe(false);
  });

  test("an unrecognized media kind fails fast with a clear reason", async () => {
    const result = await sendSmartMessage({ media: { kind: "sticker" as never, url: "https://x.com/a.webp" } }, "c1", baseDeps());
    expect(result).toEqual({ status: "failed", reason: "unsupported outbound media kind: sticker" });
  });

  test("a disallowed mime fails fast with a clear reason", async () => {
    const result = await sendSmartMessage({ media: { kind: "image", url: "https://x.com/a.gif", mimeType: "image/gif" } }, "c1", baseDeps());
    expect(result).toEqual({ status: "failed", reason: 'mime type "image/gif" not allowed (expected one of: image/jpeg, image/png, image/webp)' });
  });

  test("media combined with buttons is not preflighted (buttons win the render, media is unused)", async () => {
    // A HEAD call here would indicate the (unused) media was wrongly preflighted.
    let headCalled = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        headCalled = true;
        return new Response(null, { headers: { "content-length": "50000000" } });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await sendSmartMessage({ text: "Pick", buttons: [{ id: "a", title: "A" }], media: { kind: "image", url: "https://x.com/a.png" } }, "c1", baseDeps({ fetchImpl }));
    expect(result.status).toBe("sent");
    expect(headCalled).toBe(false);
  });
});

describe("replayPendingSends", () => {
  test("increments attempts on every replay, matching attemptAndReport's bookkeeping", async () => {
    const queue = createMemoryOutboundQueue();
    await queue.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
    await queue.update("k1", { attempts: 3 }, 0); // simulate 3 prior real attempts
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 131026, message: "x" } }), { status: 400 })) as typeof fetch;
    await replayPendingSends({ graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t", fetchImpl, clock, queue });
    expect((await queue.get("k1"))?.attempts).toBe(4);
  });

  test("re-attempts every pending item and updates the queue", async () => {
    const queue = createMemoryOutboundQueue();
    await queue.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
    await queue.enqueue({ idempotencyKey: "k2", to: "c1", payload: { type: "text" } }, 0);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls}` }] }), { status: 200 });
    }) as typeof fetch;
    const results = await replayPendingSends({ graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t", fetchImpl, clock, queue });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "sent")).toBe(true);
    expect(await queue.pending()).toEqual([]);
  });

  test("no queue configured -> nothing to replay", async () => {
    expect(await replayPendingSends({ graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t", fetchImpl: (async () => new Response()) as typeof fetch, clock })).toEqual([]);
  });

  test("queue.pending() itself throwing is reported as a failed result, not an unhandled rejection", async () => {
    const queue = queueThrowingOn("pending", new Error("EACCES: permission denied"));
    const results = await replayPendingSends({ graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t", fetchImpl: (async () => new Response()) as typeof fetch, clock, queue });
    expect(results).toEqual([{ status: "failed", reason: "outbound queue error: EACCES: permission denied" }]);
  });

  test("a failed replay is recorded as failed again, not left pending forever", async () => {
    const queue = createMemoryOutboundQueue();
    await queue.enqueue({ idempotencyKey: "k1", to: "c1", payload: { type: "text" } }, 0);
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 131026, message: "still undeliverable" } }), { status: 400 })) as typeof fetch;
    const results = await replayPendingSends({ graphApiBaseUrl: "https://api", phoneNumberId: "pn1", accessToken: "t", fetchImpl, clock, queue });
    expect(results).toEqual([{ status: "failed", reason: "meta 131026: still undeliverable" }]);
    expect((await queue.get("k1"))?.status).toBe("failed");
  });
});

describe("sendSmartMessage — outbound queue integration", () => {
  test("with a queue + idempotencyKey, a duplicate call for the same key doesn't re-send", async () => {
    const queue = createMemoryOutboundQueue();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.once" }] }), { status: 200 });
    }) as typeof fetch;
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound1" });
    const first = await sendSmartMessage({ text: "hi" }, "c1", deps);
    const second = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(first).toEqual({ status: "sent", messageId: "wamid.once" });
    expect(second).toEqual({ status: "sent", messageId: "wamid.once" });
    expect(calls).toBe(1); // the second call found the queue entry already "sent" and skipped the HTTP call entirely
  });

  test("with a queue, a failed send is recorded as failed (not left pending) and reported failed", async () => {
    const queue = createMemoryOutboundQueue();
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 131026, message: "undeliverable" } }), { status: 400 })) as typeof fetch;
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound2" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "failed", reason: "meta 131026: undeliverable" });
    expect(await queue.get("reply-to:wamid.inbound2")).toMatchObject({ status: "failed", lastError: "meta 131026: undeliverable" });
  });

  test("without a queue, sending twice hits the network twice (no dedupe)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls}` }] }), { status: 200 });
    }) as typeof fetch;
    const deps = baseDeps({ fetchImpl });
    await sendSmartMessage({ text: "hi" }, "c1", deps);
    await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(calls).toBe(2);
  });

  test("a queue error before anything is sent (enqueue throws) reports failed, not an unhandled rejection", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    }) as typeof fetch;
    const queue = queueThrowingOn("enqueue", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound3" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "failed", reason: "outbound queue error: EACCES: permission denied" });
    expect(calls).toBe(0); // must fail closed: nothing was ever sent, so reporting "failed" here is honest
  });

  test("a non-Error thrown by the queue is still stringified into a readable reason", async () => {
    const queue = queueThrowingOn("enqueue", "disk quota exceeded"); // e.g. a plain string throw
    const deps = baseDeps({ queue, idempotencyKey: "reply-to:wamid.inbound6" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "failed", reason: "outbound queue error: disk quota exceeded" });
  });

  test("a queue error claiming the item as pending (before sending) reports failed, not an unhandled rejection", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.z" }] }), { status: 200 });
    }) as typeof fetch;
    const queue = queueThrowingOnClaimUpdate(new Error("disk full"));
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound5" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "failed", reason: "outbound queue error: disk full" });
    expect(calls).toBe(0); // fails closed before the HTTP call, so nothing was actually sent
  });

  test("a queue error recording a successful send's outcome still reports sent, not failed (the message really went out)", async () => {
    const queue = queueThrowingOnOutcomeUpdate(new Error("disk full"));
    const fetchImpl = (async () => new Response(JSON.stringify({ messages: [{ id: "wamid.y" }] }), { status: 200 })) as typeof fetch;
    const deps = baseDeps({ fetchImpl, queue, idempotencyKey: "reply-to:wamid.inbound4" });
    const result = await sendSmartMessage({ text: "hi" }, "c1", deps);
    expect(result).toEqual({ status: "sent", messageId: "wamid.y" });
  });
});
