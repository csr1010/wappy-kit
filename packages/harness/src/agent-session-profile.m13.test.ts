import { describe, expect, test } from "vitest";
import { fakeChannel, fakeMemory, fakeRouter } from "@wappy/testkit";
import { createInMemoryTracer } from "@wappy/core";
import type { Clock, InboundMessage, Model, RouterDecision, SessionProfile, SessionProfileStore } from "@wappy/core";
import { createAgent } from "./agent.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: "m1", contactId: "c1", channel: "whatsapp", text: "hi", timestamp: 0, ...overrides };
}

const GREETING: RouterDecision = { intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 };

/** A minimal in-memory `SessionProfileStore`, same spirit as testkit's other fakes — exercises the
 * real interface, not a mock of agent.ts's own internals. */
function fakeSessionProfileStore(): SessionProfileStore & { data: Map<string, SessionProfile> } {
  const data = new Map<string, SessionProfile>();
  return {
    data,
    async get(contactId, now) {
      const p = data.get(contactId);
      if (!p || now > p.expiresAt) return undefined;
      return p;
    },
    async set(profile) {
      data.set(profile.contactId, profile);
    },
  };
}

function fixedClock(nowMs: number): Clock {
  return { now: () => nowMs, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {}, sleep: async () => {} };
}

describe("createAgent — session profile (M13)", () => {
  test("sessionProfileStore unset: nothing is read or written, fully backward compatible", async () => {
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "hi!" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer() });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
    // no sessionProfileStore was ever touched — nothing to assert beyond "this didn't throw", which
    // is the actual backward-compatibility claim: omitting the dep changes nothing about behavior.
  });

  test("a fresh contact (no prior profile): a successful turn writes a new profile with a fresh expiresAt", async () => {
    const store = fakeSessionProfileStore();
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", sessionFacts: { name: "Jane" }, message: { text: "hi Jane!" } } }) };
    const clock = fixedClock(1000);
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock, tracer: createInMemoryTracer(), sessionProfileStore: store, sessionProfileTtlMs: 60_000 });
    await agent.handle(msg());
    expect(store.data.get("c1")).toEqual({ contactId: "c1", facts: { name: "Jane" }, expiresAt: 61_000 });
  });

  test("facts MERGE across turns — an earlier fact survives a later turn that doesn't re-state it", async () => {
    const store = fakeSessionProfileStore();
    let call = 0;
    const model: Model = {
      generate: async () => {
        call++;
        if (call === 1) return { structured: { formatRationale: "r", sessionFacts: { name: "Jane" }, message: { text: "hi!" } } };
        return { structured: { formatRationale: "r", sessionFacts: { location: "NYC" }, message: { text: "cool!" } } };
      },
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING, GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: store });
    await agent.handle(msg({ id: "m1" }));
    await agent.handle(msg({ id: "m2" }));
    expect(store.data.get("c1")?.facts).toEqual({ name: "Jane", location: "NYC" });
  });

  test("currentState replaces wholesale when a turn produces a new one", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: {}, currentState: "old thread", expiresAt: 999_999 });
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", sessionCurrentState: "new thread", message: { text: "ok" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: store });
    await agent.handle(msg());
    expect(store.data.get("c1")?.currentState).toBe("new thread");
  });

  test("currentState/summary are carried over as-is when a turn doesn't produce a new one (allowed to lag)", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: {}, currentState: "waiting on size choice", summary: "browsing candles", expiresAt: 999_999 });
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "medium works!" } } }) }; // no sessionCurrentState/sessionSummary this turn
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: store });
    await agent.handle(msg({ text: "medium" }));
    expect(store.data.get("c1")).toMatchObject({ currentState: "waiting on size choice", summary: "browsing candles" });
  });

  test("an expired profile is read as empty, not stale — the write afterward starts a fresh profile, not a merge with the old one", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: { name: "OldContact" }, currentState: "old, expired thread", expiresAt: 500 });
    let seenPrompt = "";
    const model: Model = {
      generate: async (req) => {
        seenPrompt = req.prompt;
        return { structured: { formatRationale: "r", sessionFacts: { name: "NewName" }, message: { text: "hi!" } } };
      },
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(1000), tracer: createInMemoryTracer(), sessionProfileStore: store });
    await agent.handle(msg());
    expect(seenPrompt).not.toContain("OldContact"); // the expired profile never reached the prompt
    expect(seenPrompt).not.toContain("old, expired thread");
    expect(store.data.get("c1")?.facts).toEqual({ name: "NewName" }); // fresh, not merged with the expired one
    expect(store.data.get("c1")?.currentState).toBeUndefined();
  });

  test("the actual scenario motivating this milestone: a short, ambiguous reply composes sensibly because currentState was in the prompt", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: {}, currentState: "asked the customer which candle size they want: small, medium, or large", expiresAt: 999_999 });
    let seenPrompt = "";
    const model: Model = {
      generate: async (req) => {
        seenPrompt = req.prompt;
        return { structured: { formatRationale: "r", message: { text: "Medium it is!" } } };
      },
    };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: store });
    const result = await agent.handle(msg({ text: "medium" }));
    expect(result.status).toBe("sent");
    // The prompt the model actually saw carried the pending-question context — without it, a bare
    // "medium" is uninterpretable on its own; this is what makes it interpretable.
    expect(seenPrompt).toContain("which candle size they want");
  });

  test("an existing but entirely empty profile (no facts, no currentState, no summary) renders nothing into the prompt", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: {}, expiresAt: 999_999 });
    let seenPrompt = "";
    const model: Model = { generate: async (req) => { seenPrompt = req.prompt; return { structured: { formatRationale: "r", message: { text: "hi!" } } }; } };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: store });
    await agent.handle(msg());
    expect(seenPrompt).not.toContain("Known facts");
    expect(seenPrompt).not.toContain("Current state");
    expect(seenPrompt).not.toContain("Session summary");
  });

  test("a sessionProfileStore.get() that throws degrades to 'no profile this turn', not a crash", async () => {
    const throwingStore: SessionProfileStore = {
      get: async () => { throw new Error("backend outage"); },
      set: async () => {},
    };
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "hi!" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: throwingStore });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });

  test("a sessionProfileStore.set() that throws still lets the reply through (best-effort write)", async () => {
    const throwingStore: SessionProfileStore = {
      get: async () => undefined,
      set: async () => { throw new Error("backend outage"); },
    };
    const model: Model = { generate: async () => ({ structured: { formatRationale: "r", message: { text: "hi!" } } }) };
    const agent = createAgent({ channel: fakeChannel("whatsapp"), memory: fakeMemory(), router: fakeRouter([GREETING]), model, clock: fixedClock(0), tracer: createInMemoryTracer(), sessionProfileStore: throwingStore });
    const result = await agent.handle(msg());
    expect(result.status).toBe("sent");
  });

  test("nothing is read/written when the reply never reaches compose (e.g. an oversized-text refusal)", async () => {
    const store = fakeSessionProfileStore();
    await store.set({ contactId: "c1", facts: { name: "Jane" }, expiresAt: 999_999 });
    let modelCalled = false;
    const model: Model = { generate: async () => { modelCalled = true; return { structured: { formatRationale: "r", message: { text: "should not be reached" } } }; } };
    const agent = createAgent({
      channel: fakeChannel("whatsapp"),
      memory: fakeMemory(),
      router: fakeRouter([GREETING]),
      model,
      clock: fixedClock(0),
      tracer: createInMemoryTracer(),
      sessionProfileStore: store,
      inboundTextLimits: { maxChars: 5, refuseChars: 10 },
    });
    await agent.handle(msg({ text: "x".repeat(50) }));
    expect(modelCalled).toBe(false);
    // The write-after-send path still runs (TTL renews for every successful turn, per the design),
    // but with no compose call there's no extraction — the existing facts must survive untouched.
    expect(store.data.get("c1")?.facts).toEqual({ name: "Jane" });
  });
});
