import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryConformance } from "@wappy/testkit";
import { createLibsqlMemory } from "./memory.js";

const dirs: string[] = [];
function tmpDbUrl(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-harness-memory-"));
  dirs.push(d);
  return `file:${join(d, "memory.db")}`;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("createLibsqlMemory — conformance", () => {
  test(":memory: passes runMemoryConformance", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    const violations = await runMemoryConformance(memory, {
      contactId: "c1",
      turn: { id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 1000 },
    });
    expect(violations).toEqual([]);
  });

  test("file-backed db passes runMemoryConformance", async () => {
    const memory = createLibsqlMemory({ url: tmpDbUrl() });
    const violations = await runMemoryConformance(memory, {
      contactId: "c1",
      turn: { id: "t1", contactId: "c1", role: "agent", text: "hello!", timestamp: 1000 },
    });
    expect(violations).toEqual([]);
  });
});

describe("createLibsqlMemory — load/append", () => {
  test("load() on an unknown contact returns an empty array, not an error", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    expect(await memory.load("nope")).toEqual([]);
  });

  test("append() round-trips every field, including meta", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 1000, meta: { intent: "greeting" } });
    expect(await memory.load("c1")).toEqual([{ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 1000, meta: { intent: "greeting" } }]);
  });

  test("a turn with no text/meta round-trips without them present as null/undefined artifacts", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "system", timestamp: 1000 });
    expect(await memory.load("c1")).toEqual([{ id: "t1", contactId: "c1", role: "system", timestamp: 1000 }]);
  });

  test("turns come back in chronological (timestamp) order regardless of insertion order", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t2", contactId: "c1", role: "agent", text: "second", timestamp: 200 });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "first", timestamp: 100 });
    await memory.append({ id: "t3", contactId: "c1", role: "agent", text: "third", timestamp: 300 });
    expect((await memory.load("c1")).map((t) => t.text)).toEqual(["first", "second", "third"]);
  });

  test("different contacts' turns are isolated from each other", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "for c1", timestamp: 100 });
    await memory.append({ id: "t2", contactId: "c2", role: "user", text: "for c2", timestamp: 100 });
    expect((await memory.load("c1")).map((t) => t.text)).toEqual(["for c1"]);
    expect((await memory.load("c2")).map((t) => t.text)).toEqual(["for c2"]);
  });

  test("appending a turn with an id that's already stored is a no-op (idempotent persist)", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "first write wins", timestamp: 100 });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "a replay with different text", timestamp: 999 });
    const loaded = await memory.load("c1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.text).toBe("first write wins");
  });

  test("a fresh instance on the same file sees turns a previous instance persisted (survives restart)", async () => {
    const url = tmpDbUrl();
    const first = createLibsqlMemory({ url });
    await first.append({ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 1000 });

    const second = createLibsqlMemory({ url });
    expect(await second.load("c1")).toEqual([{ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 1000 }]);
  });
});

describe("createLibsqlMemory — recall", () => {
  test("recall() finds text snippets containing the query, case-insensitively", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "what are your store hours?", timestamp: 100 });
    await memory.append({ id: "t2", contactId: "c1", role: "agent", text: "we're open 9 to 5", timestamp: 200 });
    await memory.append({ id: "t3", contactId: "c1", role: "user", text: "thanks!", timestamp: 300 });
    const snippets = await memory.recall("c1", "HOURS");
    expect(snippets).toEqual(["what are your store hours?"]);
  });

  test("recall() is scoped to the given contact only", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "order 8842 status?", timestamp: 100 });
    await memory.append({ id: "t2", contactId: "c2", role: "user", text: "order 8842 status?", timestamp: 100 });
    expect(await memory.recall("c1", "8842")).toEqual(["order 8842 status?"]);
  });

  test("recall() with no matches returns an empty array", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "hi", timestamp: 100 });
    expect(await memory.recall("c1", "nonexistent-topic")).toEqual([]);
  });

  test("recall() treats a query containing SQL LIKE wildcards (%, _) as a literal substring, not a pattern", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", text: "discount code: SAVE_10%", timestamp: 100 });
    await memory.append({ id: "t2", contactId: "c1", role: "user", text: "discount code: SAVEX10Y", timestamp: 200 });
    // Without escaping, "_" and "%" would match ANY character, so this query would wrongly match both turns.
    expect(await memory.recall("c1", "SAVE_10%")).toEqual(["discount code: SAVE_10%"]);
  });

  test("recall() ignores turns with no text (media-only/system markers) without crashing", async () => {
    const memory = createLibsqlMemory({ url: ":memory:" });
    await memory.append({ id: "t1", contactId: "c1", role: "user", timestamp: 100 });
    expect(await memory.recall("c1", "anything")).toEqual([]);
  });
});
