import { afterAll, describe, expect, test, vi } from "vitest";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * B7, old-project compatibility: projects people already generated with create-wappy must keep
 * working when they upgrade to newer @wappy_ai/* packages. `fixtures/generated/` holds frozen
 * snapshots (append-only: a new create-wappy release adds a folder, nothing is ever edited), and
 * each one is booted here against the CURRENT workspace packages and asked to answer scenario A
 * ("hi" -> one reply sent through the WhatsApp channel). Provider SDKs and dotenv aren't installed
 * here, so they're replaced with an offline fake model; everything @wappy_ai/* is the real thing.
 *
 * The snapshot is copied under this package before import so `@wappy_ai/*` resolves through e2e's
 * own node_modules (the fixtures folder has none).
 */

const REPLY = "Hi! How can I help?";
vi.mock("dotenv/config", () => ({}));
vi.mock("@ai-sdk/openai", async () => { const { fakeProviderModel } = await import("./old-project-model.js"); return { openai: () => fakeProviderModel(REPLY) }; });
vi.mock("@ai-sdk/anthropic", async () => { const { fakeProviderModel } = await import("./old-project-model.js"); return { anthropic: () => fakeProviderModel(REPLY) }; });
vi.mock("ollama-ai-provider", async () => { const { fakeProviderModel } = await import("./old-project-model.js"); return { ollama: () => fakeProviderModel(REPLY) }; });

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../../fixtures/generated");
const workDir = resolve(here, "../.old-projects");
const snapshots = readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("B7: old generated projects still boot and answer on the current packages", () => {
  test("there is at least one snapshot to check", () => {
    expect(snapshots.length).toBeGreaterThan(0);
  });

  test.each(snapshots)("%s answers \"hi\" with one WhatsApp reply", async (name) => {
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    cpSync(join(fixturesDir, name), dir, { recursive: true });

    Object.assign(process.env, {
      WHATSAPP_PHONE_NUMBER_ID: "PN1", WHATSAPP_ACCESS_TOKEN: "TOKEN",
      MEMORY_DB_URL: ":memory:", SESSION_PROFILE_DB_URL: ":memory:", KNOWLEDGE_DB_URL: ":memory:", GOOGLE_TOKENS_DB_URL: ":memory:",
      COGNEE_BASE_URL: "http://cognee.invalid",
    });
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("graph.facebook.com")) {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }));
      }
      throw new Error(`unexpected network call in an offline test: ${url}`);
    });

    try {
      const mod = (await import(pathToFileURL(join(dir, "index.ts")).href)) as {
        channel: { receive(payload: unknown): Promise<unknown[]> };
        agent: { handle(m: unknown): Promise<{ status: string }> };
      };
      // The real path (`wappy dev`'s webhook server): Meta's payload goes through channel.receive(),
      // which dedupes and opens the 24h window, then each fresh message goes to agent.handle().
      const payload = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ id: "wamid.in1", from: "15550001111", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hi" } }] } }] }] };
      const [message] = await mod.channel.receive(payload);
      const result = await mod.agent.handle(message);
      expect(result.status).toBe("sent");
      const replies = sent.filter((s) => s.url.endsWith("/PN1/messages") && s.body.type === "text");
      expect(replies.map((r) => (r.body.text as { body: string }).body)).toEqual([REPLY]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
