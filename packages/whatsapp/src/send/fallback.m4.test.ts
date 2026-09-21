import { describe, expect, test } from "vitest";
import { createFallbackOptionsStore, renderNumberedFallback } from "./fallback.js";

describe("renderNumberedFallback", () => {
  test("buttons become a numbered list with an instruction line", () => {
    const r = renderNumberedFallback({ text: "Pick one", buttons: [{ id: "a", title: "Store hours" }, { id: "b", title: "Track order" }] });
    expect(r.text).toBe("Pick one\n1. Store hours\n2. Track order\nReply with a number (1-2).");
    expect(r.options).toEqual([
      { number: 1, id: "a", title: "Store hours" },
      { number: 2, id: "b", title: "Track order" },
    ]);
  });

  test("list rows across multiple sections are numbered sequentially", () => {
    const r = renderNumberedFallback({
      list: { buttonText: "Pick", sections: [{ title: "A", rows: [{ id: "r1", title: "One" }] }, { title: "B", rows: [{ id: "r2", title: "Two" }, { id: "r3", title: "Three" }] }] },
    });
    expect(r.options.map((o) => [o.number, o.title])).toEqual([[1, "One"], [2, "Two"], [3, "Three"]]);
  });

  test("plain text with no options omits the instruction line and has no options", () => {
    const r = renderNumberedFallback({ text: "just text" });
    expect(r).toEqual({ text: "just text", options: [] });
  });
});

describe("createFallbackOptionsStore", () => {
  test("a numeric reply within range resolves to the matching option", () => {
    const store = createFallbackOptionsStore();
    store.record("c1", [{ number: 1, id: "a", title: "A" }, { number: 2, id: "b", title: "B" }], 0);
    expect(store.resolve("c1", "2", 10)).toEqual({ number: 2, id: "b", title: "B" });
  });

  test("tolerates surrounding whitespace", () => {
    const store = createFallbackOptionsStore();
    store.record("c1", [{ number: 1, id: "a", title: "A" }], 0);
    expect(store.resolve("c1", "  1  ", 10)).toEqual({ number: 1, id: "a", title: "A" });
  });

  test("a non-numeric or out-of-range reply doesn't resolve", () => {
    const store = createFallbackOptionsStore();
    store.record("c1", [{ number: 1, id: "a", title: "A" }], 0);
    expect(store.resolve("c1", "yes", 10)).toBeUndefined();
    expect(store.resolve("c1", "99", 10)).toBeUndefined();
    expect(store.resolve("c1", "1 or 2", 10)).toBeUndefined();
  });

  test("a contact with no pending options never resolves", () => {
    expect(createFallbackOptionsStore().resolve("nobody", "1", 0)).toBeUndefined();
  });

  test("expired options (past TTL) no longer resolve", () => {
    const store = createFallbackOptionsStore(100);
    store.record("c1", [{ number: 1, id: "a", title: "A" }], 0);
    expect(store.resolve("c1", "1", 100)).toBeUndefined();
  });

  test("a resolved match is consumed — a second identical reply doesn't re-match", () => {
    const store = createFallbackOptionsStore();
    store.record("c1", [{ number: 1, id: "a", title: "A" }], 0);
    expect(store.resolve("c1", "1", 1)).toEqual({ number: 1, id: "a", title: "A" });
    expect(store.resolve("c1", "1", 2)).toBeUndefined();
  });

  test("a later record() replaces the pending options for that contact", () => {
    const store = createFallbackOptionsStore();
    store.record("c1", [{ number: 1, id: "a", title: "A" }], 0);
    store.record("c1", [{ number: 1, id: "z", title: "Z" }], 5);
    expect(store.resolve("c1", "1", 6)).toEqual({ number: 1, id: "z", title: "Z" });
  });
});
