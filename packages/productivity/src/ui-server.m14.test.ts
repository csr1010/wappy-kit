import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnectUiServer, type OAuthConnectPlugin } from "./ui-server.js";

/**
 * v3 (plan pivot: the task list is retired — this is now just the "connect Google" page). Boots a
 * real server on an ephemeral port and issues real fetch() calls — same pattern as
 * @wappy_ai/whatsapp's webhook-server tests.
 */

let server: Server;
let base: string;

beforeEach(async () => {
  server = createConnectUiServer({});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createConnectUiServer", () => {
  test("GET / serves the HTML page", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connect Google");
  });

  test("the page states it's read-only and open source, without a task list", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain("read");
    expect(html).toContain("open-source");
    expect(html).not.toContain("/api/tasks");
    expect(html).not.toContain("templates");
  });

  test("GET /api/oauth-status with no plugin configured reports unavailable", async () => {
    const status = await (await fetch(base + "/api/oauth-status")).json();
    expect(status).toEqual({ available: false, connected: false, label: null, authUrl: null });
  });

  test("an unknown route is a real 404, not a crash", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });
});

describe("createConnectUiServer — oauthConnect plugin (generic, no Google-specific code here)", () => {
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
    pluginServer = createConnectUiServer({ oauthConnect: plugin });
    await new Promise<void>((resolve) => pluginServer.listen(0, "127.0.0.1", resolve));
    pluginBase = `http://127.0.0.1:${(pluginServer.address() as AddressInfo).port}`;
  }

  test("GET /api/oauth-status reflects the plugin's available/connected/label/authUrl", async () => {
    await boot(fakePlugin());
    const status = await (await fetch(pluginBase + "/api/oauth-status")).json();
    expect(status).toEqual({ available: true, connected: false, label: "TestVendor", authUrl: "https://example.com/consent" });
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
    await fetch(pluginBase + "/api/oauth-status");
    expect(plugin.handledUrls).toHaveLength(0);
  });
});
