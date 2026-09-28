import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { Agent, DeliveryResult, MessageChannel } from "@wappy_ai/core";
import { runDev, type TaskRunnerLike } from "./dev.js";

/** Phase 5 (plan): `wappy dev` boots the task UI server and starts the task runner alongside the
 * webhook server, only when a generated project actually exports them (productivity=yes). */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function projectDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wappy-dev-productivity-"));
  dirs.push(d);
  writeFileSync(join(d, "index.ts"), "// placeholder — importProject is injected in these tests\n");
  return d;
}

function fakeChannel(): MessageChannel {
  return { name: "whatsapp", receive: async () => [], send: async (): Promise<DeliveryResult> => ({ status: "sent" }) };
}
function fakeAgent(): Agent {
  return { handle: async (): Promise<DeliveryResult> => ({ status: "sent" }) };
}
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
function fakeTaskRunner(): TaskRunnerLike & { started: boolean; stopped: boolean } {
  const r = { started: false, stopped: false, start: () => (r.started = true), stop: () => (r.stopped = true) };
  return r;
}

const ENV = { WHATSAPP_VERIFY_TOKEN: "vt", WHATSAPP_APP_SECRET: "secret" };

describe("runDev — productivity agent (taskUiServer/taskRunner exports)", () => {
  test("a project WITHOUT productivity exports never touches a task UI server or runner", async () => {
    const webhookServer = fakeServer();
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel() }));
    const result = await runDev({ cwd: projectDir(), print: () => {}, env: ENV, createServer: () => webhookServer, importProject, tunnel: false });
    expect(result.exitCode).toBe(0);
    // No taskUiServer/taskRunner on the resolved project — nothing extra should have been booted;
    // implicitly proven by the happy-path tests in dev.m9.test.ts never mentioning a second port.
  });

  test("a project WITH productivity exports boots the task UI server and starts the runner", async () => {
    const print = vi.fn();
    const webhookServer = fakeServer();
    const taskUiServer = fakeServer();
    const taskUiListen = vi.spyOn(taskUiServer, "listen");
    const taskRunner = fakeTaskRunner();
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel(), taskUiServer, taskRunner }));

    const result = await runDev({ cwd: projectDir(), print, env: ENV, port: 4321, createServer: () => webhookServer, importProject, tunnel: false });

    expect(result.exitCode).toBe(0);
    expect(taskUiListen).toHaveBeenCalledWith(4322, expect.any(Function)); // webhook port + 1 by default
    expect(taskRunner.started).toBe(true);
    expect(print).toHaveBeenCalledWith(expect.stringContaining("4322"));
  });

  test("TASK_UI_PORT env var overrides the default webhook-port+1", async () => {
    const webhookServer = fakeServer();
    const taskUiServer = fakeServer();
    const taskUiListen = vi.spyOn(taskUiServer, "listen");
    const taskRunner = fakeTaskRunner();
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel(), taskUiServer, taskRunner }));

    await runDev({ cwd: projectDir(), print: () => {}, env: { ...ENV, TASK_UI_PORT: "7000" }, port: 4321, createServer: () => webhookServer, importProject, tunnel: false });

    expect(taskUiListen).toHaveBeenCalledWith(7000, expect.any(Function));
  });

  test("close() stops the task runner and closes the task UI server too", async () => {
    const webhookServer = fakeServer();
    const taskUiServer = fakeServer();
    const taskUiCloseSpy = vi.spyOn(taskUiServer, "close");
    const taskRunner = fakeTaskRunner();
    const importProject = vi.fn(async () => ({ agent: fakeAgent(), channel: fakeChannel(), taskUiServer, taskRunner }));

    const result = await runDev({ cwd: projectDir(), print: () => {}, env: ENV, createServer: () => webhookServer, importProject, tunnel: false });
    await result.close?.();

    expect(taskRunner.stopped).toBe(true);
    expect(taskUiCloseSpy).toHaveBeenCalled();
  });
});
