import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, DeliveryResult, MessageChannel } from "@wappy/core";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { runDev } from "./dev.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function projectDir(withIndex = true): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-dev-"));
  dirs.push(d);
  if (withIndex) writeFileSync(join(d, "index.ts"), "// placeholder — importProject is injected in these tests\n");
  return d;
}

function fakeChannel(): MessageChannel {
  return { name: "whatsapp", receive: async () => [], send: async (): Promise<DeliveryResult> => ({ status: "sent" }) };
}
function fakeAgent(): Agent {
  return { handle: async (): Promise<DeliveryResult> => ({ status: "sent" }) };
}

/** A fake `http.Server` good enough for runDev's own use of it: listen()/close()/once("error"). */
function fakeServer(): Server {
  const emitter = new EventEmitter() as unknown as Server;
  emitter.listen = ((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
    queueMicrotask(() => cb?.());
    return emitter;
  }) as Server["listen"];
  emitter.close = ((cb?: () => void) => {
    queueMicrotask(() => cb?.());
    return emitter;
  }) as Server["close"];
  return emitter;
}

const ENV = { WHATSAPP_VERIFY_TOKEN: "vt", WHATSAPP_APP_SECRET: "secret" };

describe("runDev — preflight checks (fail loud, don't half-start)", () => {
  test("no index.ts in cwd -> clear message, exit 1, no server touched", async () => {
    const print = vi.fn();
    const createServer = vi.fn();
    const result = await runDev({ cwd: projectDir(false), print, env: ENV, createServer });
    expect(result.exitCode).toBe(1);
    expect(print.mock.calls[0]![0]).toContain("run this from inside a generated project");
    expect(createServer).not.toHaveBeenCalled();
  });

  test("missing WHATSAPP_VERIFY_TOKEN or WHATSAPP_APP_SECRET -> clear message, exit 1, project never imported", async () => {
    const print = vi.fn();
    const importProject = vi.fn();
    const result = await runDev({ cwd: projectDir(), print, env: {}, importProject });
    expect(result.exitCode).toBe(1);
    expect(print.mock.calls[0]![0]).toContain("WHATSAPP_VERIFY_TOKEN");
    expect(importProject).not.toHaveBeenCalled();
  });

  test("importProject throwing (e.g. a bad Shopify/model env value) is caught, not a crash, with a pointer to .env", async () => {
    const print = vi.fn();
    const importProject = vi.fn(async () => {
      throw new Error("createShopifyToolProvider: either storeDomain or graphqlUrlOverride is required.");
    });
    const result = await runDev({ cwd: projectDir(), print, env: ENV, importProject });
    expect(result.exitCode).toBe(1);
    expect(print).toHaveBeenCalledWith(expect.stringContaining("storeDomain"));
    expect(print).toHaveBeenCalledWith(expect.stringContaining(".env.sample"));
  });

  test("index.ts exporting only agent (an older generated project, pre-M9 channel export) is rejected with a clear upgrade hint", async () => {
    const print = vi.fn();
    const importProject = vi.fn(async () => ({ agent: fakeAgent() }) as never);
    const result = await runDev({ cwd: projectDir(), print, env: ENV, importProject });
    expect(result.exitCode).toBe(1);
    expect(print.mock.calls.at(-1)![0]).toContain("regenerate");
  });
});

describe("runDev — loads .env from disk itself, BEFORE the preflight check (regression)", () => {
  // Caught by hand-testing the real CLI, not by a unit test: runDev used to read
  // WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET from process.env BEFORE importing index.ts, but
  // .env was only ever loaded as a side effect of THAT import — so a correctly filled-in .env
  // still produced a false "missing" error. This test uses real process.env (opts.env omitted)
  // and a real .env file on disk, exactly like the actual CLI invocation that found the bug.
  test("a real .env file on disk with valid values passes the preflight check", async () => {
    const dir = projectDir();
    writeFileSync(join(dir, ".env"), "WHATSAPP_VERIFY_TOKEN=vt-from-disk\nWHATSAPP_APP_SECRET=secret-from-disk\n");
    const savedKeys = ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"] as const;
    const saved = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));
    for (const k of savedKeys) delete process.env[k];
    try {
      const server = fakeServer();
      const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
      const result = await runDev({ cwd: dir, print: () => {}, createServer: () => server, importProject, tunnel: false });
      expect(result.exitCode).toBe(0);
      expect(process.env.WHATSAPP_VERIFY_TOKEN).toBe("vt-from-disk");
    } finally {
      for (const k of savedKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("runDev — defaultImportProject (no injected fake): a real dynamic import of index.ts", () => {
  test("imports the real file and picks up its agent/channel exports", async () => {
    const dir = projectDir(false);
    writeFileSync(
      join(dir, "index.ts"),
      'export const agent = { handle: async () => ({ status: "sent" }) };\n' + 'export const channel = { name: "whatsapp", receive: async () => [], send: async () => ({ status: "sent" }) };\n',
    );
    const print = vi.fn();
    const server = fakeServer();
    const result = await runDev({ cwd: dir, print, env: ENV, createServer: () => server, tunnel: false });
    expect(result.exitCode).toBe(0);
  });
});

describe("runDev — happy path", () => {
  test("boots the server on the given port and reports the local URL", async () => {
    const print = vi.fn();
    const server = fakeServer();
    const createServer = vi.fn(() => server);
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    const result = await runDev({ cwd: projectDir(), print, env: ENV, port: 4321, createServer, importProject, tunnel: false });
    expect(result.exitCode).toBe(0);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ verifyToken: "vt", appSecret: "secret" }));
    expect(print).toHaveBeenCalledWith(expect.stringContaining("4321"));
    expect(print).toHaveBeenCalledWith(expect.stringContaining("/webhook"));
  });

  test("PORT env var is used when --port wasn't given; explicit port wins over PORT", async () => {
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));

    const fromEnv = fakeServer();
    const fromEnvListen = vi.spyOn(fromEnv, "listen");
    await runDev({ cwd: projectDir(), print: () => {}, env: { ...ENV, PORT: "5555" }, createServer: () => fromEnv, importProject, tunnel: false });
    expect(fromEnvListen).toHaveBeenCalledWith(5555, expect.any(Function));

    const explicit = fakeServer();
    const explicitListen = vi.spyOn(explicit, "listen");
    await runDev({ cwd: projectDir(), print: () => {}, env: { ...ENV, PORT: "5555" }, port: 9999, createServer: () => explicit, importProject, tunnel: false });
    expect(explicitListen).toHaveBeenCalledWith(9999, expect.any(Function));
  });

  test("tunnel: true (default) calls openTunnel and reports the public URL", async () => {
    const print = vi.fn();
    const server = fakeServer();
    const openTunnel = vi.fn(async () => ({ url: "https://abc123.loca.lt", close: async () => {} }));
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    const result = await runDev({ cwd: projectDir(), print, env: ENV, createServer: () => server, importProject, openTunnel });
    expect(result.exitCode).toBe(0);
    expect(openTunnel).toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(expect.stringContaining("https://abc123.loca.lt/webhook"));
  });

  test("tunnel: false never calls openTunnel", async () => {
    const server = fakeServer();
    const openTunnel = vi.fn();
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    await runDev({ cwd: projectDir(), print: () => {}, env: ENV, createServer: () => server, importProject, openTunnel, tunnel: false });
    expect(openTunnel).not.toHaveBeenCalled();
  });

  test("a tunnel failure degrades to \"still running locally\" rather than failing the whole command", async () => {
    const print = vi.fn();
    const server = fakeServer();
    const openTunnel = vi.fn(async () => {
      throw new Error("network down");
    });
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    const result = await runDev({ cwd: projectDir(), print, env: ENV, createServer: () => server, importProject, openTunnel });
    expect(result.exitCode).toBe(0);
    expect(print).toHaveBeenCalledWith(expect.stringContaining("still running locally"));
  });

  test("close() shuts down both the tunnel and the server", async () => {
    const server = fakeServer();
    const closeSpy = vi.spyOn(server, "close");
    const tunnelClose = vi.fn(async () => {});
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    const result = await runDev({ cwd: projectDir(), print: () => {}, env: ENV, createServer: () => server, importProject, openTunnel: async () => ({ url: "https://x.loca.lt", close: tunnelClose }) });
    await result.close?.();
    expect(tunnelClose).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });
});
