import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTaskUiServer } from "./ui-server.js";
import { createTaskStore, type TaskStore } from "./store.js";

/** Phase 4 (plan: "Local web UI — the ASCII-mocked task list"). Boots a real server on an ephemeral
 * port and issues real fetch() calls — same pattern as @wappy_ai/whatsapp's webhook-server tests. */

let server: Server;
let base: string;
let store: TaskStore;

function fakeClock(now: number) {
  return { now: () => now, setTimeout: () => 0, clearTimeout: () => {}, sleep: async () => {} };
}

beforeEach(async () => {
  store = createTaskStore({ url: ":memory:" });
  server = createTaskUiServer({ store, clock: fakeClock(1_000_000) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createTaskUiServer", () => {
  test("GET / serves the HTML page", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Your Tasks");
  });

  test("GET /api/templates lists all 5 templates", async () => {
    const res = await fetch(base + "/api/templates");
    const templates = await res.json();
    expect(templates).toHaveLength(5);
  });

  test("GET /api/tasks starts empty, then reflects a created task", async () => {
    expect(await (await fetch(base + "/api/tasks")).json()).toEqual([]);

    const createRes = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId: "+15551234567", templateId: "reminder", placeholders: { text: "call mom", time: "17:00" }, scheduleKind: "dailyAt", scheduleValue: "17:00" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.title).toContain("call mom");

    const list = await (await fetch(base + "/api/tasks")).json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  test("POST /api/tasks rejects a missing required field", async () => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "reminder" }),
    });
    expect(res.status).toBe(400);
  });

  test("PATCH .../:id with a status flips on/off (the play/stop toggle)", async () => {
    const created = await store.create({ contactId: "+1", templateId: "reminder", title: "t", placeholders: {}, scheduleKind: "dailyAt", scheduleValue: "09:00" }, 1000);
    const res = await fetch(`${base}/api/tasks/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "off" }) });
    expect(res.status).toBe(200);
    const [after] = await store.listAll();
    expect(after!.status).toBe("off");
  });

  test("PATCH .../:id with placeholders edits inline and persists", async () => {
    const created = await store.create({ contactId: "+1", templateId: "reminder", title: "t", placeholders: { text: "call mom" }, scheduleKind: "dailyAt", scheduleValue: "09:00" }, 1000);
    await fetch(`${base}/api/tasks/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ placeholders: { text: "call dad" } }) });
    const [after] = await store.listAll();
    expect(after!.placeholders).toEqual({ text: "call dad" });
  });

  test("DELETE .../:id removes the task", async () => {
    const created = await store.create({ contactId: "+1", templateId: "reminder", title: "t", placeholders: {}, scheduleKind: "dailyAt", scheduleValue: "09:00" }, 1000);
    const res = await fetch(`${base}/api/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await store.listAll()).toHaveLength(0);
  });

  test("an unknown route is a real 404, not a crash", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });
});
