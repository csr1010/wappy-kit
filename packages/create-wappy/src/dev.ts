import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { config as loadDotenv } from "dotenv";
import type { Agent, MessageChannel } from "@wappy/core";
import { createWebhookServer } from "@wappy/whatsapp";

/**
 * T9.7's `wappy dev`: boots the real webhook server (`@wappy/whatsapp`'s `createWebhookServer`,
 * M9) against a GENERATED project's own `index.ts`, and optionally opens a tunnel so Meta can
 * reach it. Run from inside that project's directory (`npm run dev`, which resolves the `wappy`
 * bin from the project's own `@wappy/create-agent` dependency — see templates.ts's renderPackageJson).
 *
 * Deliberately dynamic-imports `<cwd>/index.ts` directly rather than requiring a build step. Loads
 * `<cwd>/.env` itself (via `dotenv`), explicitly and first — NOT by relying on the generated
 * project's own `import "dotenv/config"` as a side effect of importing it: that import happens
 * AFTER this module would otherwise need to read WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET,
 * so relying on it made this file's own preflight check see an empty environment and report a
 * false "missing" error even when `.env` was filled in correctly (caught by hand-testing the real
 * CLI, not by a unit test — the unit tests all injected env directly).
 */

export interface GeneratedProjectExports {
  agent: Agent;
  channel: MessageChannel;
}

export interface RunDevOptions {
  cwd: string;
  print: (line: string) => void;
  /** Injected for testing — real callers omit this and get the real dynamic import. */
  importProject?: (indexUrl: string) => Promise<GeneratedProjectExports>;
  /** Injected for testing — real callers omit this and get @wappy/whatsapp's real server. */
  createServer?: typeof createWebhookServer;
  /** Injected for testing (avoids a real tunnel/network dependency in unit tests). Real callers
   * omit this and, unless `--no-tunnel` was passed, get a real localtunnel. */
  openTunnel?: (port: number) => Promise<{ url: string; close: () => Promise<void> }>;
  port?: number;
  env?: NodeJS.ProcessEnv;
  tunnel?: boolean;
}

export interface RunDevResult {
  exitCode: number;
  /** Exposed so a test (or a future `wappy stop`) can shut things down; undefined on early exit. */
  close?: () => Promise<void>;
}

async function defaultImportProject(indexUrl: string): Promise<GeneratedProjectExports> {
  return (await import(indexUrl)) as GeneratedProjectExports;
}

async function defaultOpenTunnel(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  // Lazy `require`, not a static import: @wappy/create-agent's own startup cost shouldn't include
  // localtunnel's dependency tree for the (more common) scaffold-only, never-`dev`
  // invocation. `require` (not dynamic `import()`) sidesteps localtunnel's `export =` CJS shape
  // not lining up with TypeScript's `.default` typing for a dynamically-imported CJS module.
  const localtunnel = createRequire(import.meta.url)("localtunnel") as typeof import("localtunnel");
  const tunnel = await localtunnel({ port });
  return { url: tunnel.url, close: async () => tunnel.close() };
}

export async function runDev(opts: RunDevOptions): Promise<RunDevResult> {
  // Only load .env from disk for the real (opts.env omitted) path — a test supplying its own env
  // object is asserting on an exact, controlled environment and shouldn't have it silently
  // augmented by whatever .env happens to exist in cwd.
  if (!opts.env) loadDotenv({ path: resolve(opts.cwd, ".env") });
  const env = opts.env ?? process.env;
  const indexPath = resolve(opts.cwd, "index.ts");
  if (!existsSync(indexPath)) {
    opts.print(`No index.ts found in ${opts.cwd} — run this from inside a generated project's directory.`);
    return { exitCode: 1 };
  }

  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  const appSecret = env.WHATSAPP_APP_SECRET;
  if (!verifyToken || !appSecret) {
    opts.print("Missing WHATSAPP_VERIFY_TOKEN and/or WHATSAPP_APP_SECRET in .env — fill in .env.sample's WhatsApp section first (see README.md).");
    return { exitCode: 1 };
  }

  let project: GeneratedProjectExports;
  try {
    project = await (opts.importProject ?? defaultImportProject)(pathToFileURL(indexPath).href);
  } catch (e) {
    opts.print(`Failed to start: ${e instanceof Error ? e.message : String(e)}`);
    opts.print("This usually means a required env key is missing or invalid — check .env against .env.sample, or run `wappy doctor` (once available).");
    return { exitCode: 1 };
  }
  // Checked here (not just in defaultImportProject) so an injected importProject is held to the
  // same contract — e.g. an older generated project's index.ts that predates the "export channel
  // too" change (this milestone) fails with a clear upgrade hint instead of a confusing crash
  // three lines later when project.channel turns out to be undefined.
  if (!project.agent || !project.channel) {
    opts.print('index.ts must export both "agent" and "channel" — regenerate the project (an older index.ts only exported "agent").');
    return { exitCode: 1 };
  }

  const port = opts.port ?? Number(env.PORT ?? 3000);
  const errors: unknown[] = [];
  const server = (opts.createServer ?? createWebhookServer)({
    verifyToken,
    appSecret,
    channel: project.channel,
    agent: project.agent,
    onError: (e) => {
      errors.push(e);
      opts.print(`[error] ${e instanceof Error ? e.message : String(e)}`);
    },
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolvePromise());
  });
  opts.print(`Webhook server listening on http://localhost:${port}/webhook`);

  let tunnelClose: (() => Promise<void>) | undefined;
  if (opts.tunnel !== false) {
    try {
      const t = await (opts.openTunnel ?? defaultOpenTunnel)(port);
      tunnelClose = t.close;
      opts.print(`Public webhook URL: ${t.url}/webhook`);
      opts.print(`Paste that URL (with /webhook) and your WHATSAPP_VERIFY_TOKEN into Meta's webhook configuration.`);
    } catch (e) {
      opts.print(`Tunnel failed to start (${e instanceof Error ? e.message : String(e)}) — the server is still running locally on port ${port}.`);
    }
  }

  const close = async () => {
    await tunnelClose?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { exitCode: 0, close };
}
