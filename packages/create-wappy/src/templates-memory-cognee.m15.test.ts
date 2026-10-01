import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * M15 (plan: "Memory backend — local vs. Cognee"). Confirms the `memory` interview step actually
 * changes generated output, mirroring `templates-productivity.m14.test.ts`'s own structure: a
 * `withMemory()` fixture helper, positive assertions for the chosen backend, negative assertions for
 * the other one — never both wired at once.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.1", productivity: "0.1.0", connectorGoogle: "0.1.0", connectorCognee: "0.1.0", createWappy: "0.1.0" };

function withMemory(backend: "local" | "cognee"): CompleteInterviewAnswers {
  return { model: DEFAULT_ANSWERS.model, memory: { backend }, productivity: DEFAULT_ANSWERS.productivity };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("renderProject — memory: local (default)", () => {
  const files = fileMap(renderProject({ answers: withMemory("local"), versions: VERSIONS }));
  const indexTs = files.get("index.ts")!;

  test("index.ts wires createKnowledge against a local @libsql/client, not Cognee", () => {
    expect(indexTs).toContain("createKnowledge");
    expect(indexTs).toContain("createKnowledgeRag");
    expect(indexTs).toContain('import { createClient } from "@libsql/client";');
    expect(indexTs).not.toContain("@wappy_ai/connector-cognee");
    expect(indexTs).not.toContain("createCogneeKnowledge");
  });

  test("package.json depends on @libsql/client, not @wappy_ai/connector-cognee", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@libsql/client"]).toBe("0.18.0");
    expect(pkg.dependencies["@wappy_ai/connector-cognee"]).toBeUndefined();
  });

  test("no COGNEE_SETUP.md is generated", () => {
    expect(files.has("COGNEE_SETUP.md")).toBe(false);
  });

  test(".env.sample lists KNOWLEDGE_DB_URL, not COGNEE_BASE_URL/COGNEE_API_KEY", () => {
    const env = files.get(".env.sample")!;
    expect(env).toContain("\n# KNOWLEDGE_DB_URL=\n");
    expect(env).not.toContain("COGNEE_BASE_URL");
    expect(env).not.toContain("COGNEE_API_KEY");
  });

  test("README describes the local memory backend", () => {
    expect(files.get("README.md")!).toContain("Memory backend:** Local");
  });
});

describe("renderProject — memory: cognee", () => {
  const files = fileMap(renderProject({ answers: withMemory("cognee"), versions: VERSIONS }));
  const indexTs = files.get("index.ts")!;

  test("index.ts imports and wires createCogneeKnowledge, not the local @libsql/client path", () => {
    expect(indexTs).toContain('import { createCogneeKnowledge } from "@wappy_ai/connector-cognee";');
    expect(indexTs).toContain("createCogneeKnowledge({ baseUrl: process.env.COGNEE_BASE_URL!, apiKey: process.env.COGNEE_API_KEY })");
    expect(indexTs).toContain("createKnowledgeRag");
    expect(indexTs).not.toContain('import { createClient } from "@libsql/client";');
  });

  test("package.json depends on @wappy_ai/connector-cognee, not @libsql/client", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@wappy_ai/connector-cognee"]).toBe("0.1.0");
    expect(pkg.dependencies["@libsql/client"]).toBeUndefined();
  });

  test(".env.sample lists COGNEE_BASE_URL (looks required) and COGNEE_API_KEY (optional), not KNOWLEDGE_DB_URL's local-only framing", () => {
    const env = files.get(".env.sample")!;
    expect(env).toContain("COGNEE_BASE_URL=\n");
    expect(env).not.toContain("# COGNEE_BASE_URL="); // required: left blank, NOT commented out
    expect(env).toContain("\n# COGNEE_API_KEY=\n"); // optional: commented out
  });

  test("COGNEE_SETUP.md is generated with the real base URL/API key guidance and the honest self-hosted-LLM caveat", () => {
    const setup = files.get("COGNEE_SETUP.md")!;
    expect(setup).toBeTruthy();
    expect(setup).toContain("COGNEE_BASE_URL");
    expect(setup).toContain("COGNEE_API_KEY");
    expect(setup).toMatch(/LLM.*(api key|requirement)/i);
  });

  test("README describes the Cognee memory backend and links COGNEE_SETUP.md", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("Memory backend:** Cognee");
    expect(readme).toContain("COGNEE_SETUP.md");
  });
});
