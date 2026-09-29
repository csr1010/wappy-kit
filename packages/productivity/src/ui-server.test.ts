import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTaskUiServer, type OAuthConnectPlugin } from "./ui-server.js";
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

  test("GET /api/templates lists all 4 templates", async () => {
    const res = await fetch(base + "/api/templates");
    const templates = await res.json();
    expect(templates).toHaveLength(4);
  });

  test("GET /api/tasks starts empty, then reflects a created task", async () => {
    expect(await (await fetch(base + "/api/tasks")).json()).toEqual([]);

    const createRes = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId: "+15551234567", templateId: "find_emails", placeholders: { query: "invoices" } }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.title).toContain("invoices");

    const list = await (await fetch(base + "/api/tasks")).json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  test("POST /api/tasks rejects a missing required field", async () => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId: "find_emails" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/tasks with a blank placeholder still creates the task (the template's own default applies)", async () => {
    const res = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId: "+1", templateId: "summarize_emails", placeholders: { from: "" } }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.title).toBe("Summarize my unread emails");
  });

  test("PATCH .../:id with placeholders edits inline and persists", async () => {
    const created = await store.create({ contactId: "+1", templateId: "find_emails", title: "t", placeholders: { query: "invoices" } }, 1000);
    await fetch(`${base}/api/tasks/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ placeholders: { query: "travel" } }) });
    const [after] = await store.listAll();
    expect(after!.placeholders).toEqual({ query: "travel" });
  });

  test("DELETE .../:id removes the task", async () => {
    const created = await store.create({ contactId: "+1", templateId: "find_emails", title: "t", placeholders: {} }, 1000);
    const res = await fetch(`${base}/api/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await store.listAll()).toHaveLength(0);
  });

  test("an unknown route is a real 404, not a crash", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });
});

describe("createTaskUiServer — oauthConnect plugin (generic, no Google-specific code here)", () => {
  let pluginServer: Server;
  let pluginBase: string;

  afterEach(async () => {
    await new Promise<void>((resolve) => pluginServer.close(() => resolve()));
  });

  function fakePlugin(overrides: Partial<OAuthConnectPlugin> = {}): OAuthConnectPlugin & { handledUrls: URL[] } {
    const handledUrls: URL[] = [];
    return {
      label: "TestVendor",
      isAvailable: () => true,
      isConnected: () => false,
      authUrl: () => "https://example.com/consent",
      callbackPath: "/testvendor/callback",
      handledUrls,
      async handleCallback(url) {
        handledUrls.push(url);
        return true;
      },
      ...overrides,
    };
  }

  async function boot(plugin: OAuthConnectPlugin) {
    const testStore = createTaskStore({ url: ":memory:" });
    pluginServer = createTaskUiServer({ store: testStore, clock: fakeClock(1_000_000), oauthConnect: plugin });
    await new Promise<void>((resolve) => pluginServer.listen(0, "127.0.0.1", resolve));
    pluginBase = `http://127.0.0.1:${(pluginServer.address() as AddressInfo).port}`;
  }

  test("GET /api/oauth-status reflects the plugin's available/connected/label/authUrl", async () => {
    await boot(fakePlugin());
    const status = await (await fetch(pluginBase + "/api/oauth-status")).json();
    expect(status).toEqual({ available: true, connected: false, label: "TestVendor", authUrl: "https://example.com/consent" });
  });

  test("GET /api/oauth-status with no plugin configured reports unavailable", async () => {
    const testStore = createTaskStore({ url: ":memory:" });
    pluginServer = createTaskUiServer({ store: testStore, clock: fakeClock(1_000_000) });
    await new Promise<void>((resolve) => pluginServer.listen(0, "127.0.0.1", resolve));
    pluginBase = `http://127.0.0.1:${(pluginServer.address() as AddressInfo).port}`;
    const status = await (await fetch(pluginBase + "/api/oauth-status")).json();
    expect(status.available).toBe(false);
  });

  test("a request to the plugin's callbackPath is routed to handleCallback, and redirects to / on success", async () => {
    const plugin = fakePlugin();
    await boot(plugin);
    const res = await fetch(pluginBase + "/testvendor/callback?code=abc123", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(plugin.handledUrls).toHaveLength(1);
    expect(plugin.handledUrls[0]!.searchParams.get("code")).toBe("abc123");
  });

  test("handleCallback returning false falls through to a normal 404, not a crash", async () => {
    await boot(fakePlugin({ handleCallback: async () => false }));
    const res = await fetch(pluginBase + "/testvendor/callback?code=abc123");
    expect(res.status).toBe(404);
  });

  test("a request to a path that ISN'T the plugin's callbackPath never reaches handleCallback", async () => {
    const plugin = fakePlugin();
    await boot(plugin);
    await fetch(pluginBase + "/api/templates");
    expect(plugin.handledUrls).toHaveLength(0);
  });
});
