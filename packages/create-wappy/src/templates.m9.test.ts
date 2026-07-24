import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions, type RenderProjectOptions } from "./templates.js";

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0", createWappy: "0.1.0" };

function complete(overrides: Partial<InterviewAnswers> = {}): CompleteInterviewAnswers {
  const model = overrides.model ?? DEFAULT_ANSWERS.model;
  const tools = overrides.tools ?? DEFAULT_ANSWERS.tools;
  return { model, tools };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

// M12 removed the interview's "skills" step and `@wappy/harness`'s reference skills entirely — the
// generic format-reasoning/grounding-honesty prompting (SPEC §6.1/§6.3) applies regardless of what
// tools are wired, so there's nothing left for a per-skill file/registration to render. This file
// was rewritten accordingly (`--allow-test-change`, SPEC.md decisions log).
describe("renderProject — golden path (openai + shopify)", () => {
  const opts: RenderProjectOptions = {
    answers: complete({
      model: { provider: "openai" },
      tools: { kind: "shopify" },
    }),
    versions: VERSIONS,
    projectName: "luna-and-co-bot",
  };
  const files = fileMap(renderProject(opts));

  test("renders exactly the §4.1-listed output files, plus per-tool files — no skills/*.ts", () => {
    expect([...files.keys()].sort()).toEqual(["README.md", ".env.sample", ".gitignore", "index.ts", "package.json", "tools/shopify.ts"].sort());
  });

  test("index.ts imports the OpenAI adapter and wires model/memory/sessionProfileStore/router/tools/channel — no skills/rag wiring", () => {
    const indexTs = files.get("index.ts")!;
    expect(indexTs).toContain('import { openai } from "@ai-sdk/openai";');
    expect(indexTs).toContain('openai(process.env.OPENAI_MODEL ?? "gpt-4o")');
    expect(indexTs).toContain("createLibsqlMemory");
    expect(indexTs).toContain("createLibsqlSessionProfileStore");
    expect(indexTs).toContain("sessionProfileStore,");
    expect(indexTs).toContain("createLlmRouter({ model })");
    expect(indexTs).toContain("const toolProvider = createShopifyToolProvider(");
    expect(indexTs).toContain("const invokeTools = createToolInvoker({ model, tools });");
    expect(indexTs).not.toContain("createSkillRegistry");
    expect(indexTs).not.toContain("createKnowledge");
    expect(indexTs).not.toContain("createKnowledgeRag");
    expect(indexTs).toContain("createWhatsAppChannel({");
    expect(indexTs).toContain("export const agent = createAgent({");
  });

  test("tools/shopify.ts wires the real Shopify connector with the domain read from env", () => {
    const toolsFile = files.get("tools/shopify.ts")!;
    expect(toolsFile).toContain('import { createShopifyToolProvider } from "@wappy/tools-openapi";');
    expect(toolsFile).toContain("storeDomain: process.env.SHOPIFY_STORE_DOMAIN!");
  });

  test(".env.sample lists every key needed to run, blank — never a real secret value", () => {
    const env = files.get(".env.sample")!;
    for (const key of ["OPENAI_API_KEY", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) {
      expect(env).toContain(`\n${key}=\n`);
    }
    // Every non-comment line is a bare "KEY=" placeholder.
    for (const line of env.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"))) {
      expect(line).toMatch(/^[A-Z0-9_]+=$/);
    }
  });

  test(".env.sample is grouped, explains where each key comes from, and comments out optional keys", () => {
    const env = files.get(".env.sample")!;
    for (const group of ["Model", "WhatsApp", "Shopify", "Memory"]) expect(env).toContain(`── ${group} `);
    expect(env).toContain("https://platform.openai.com/api-keys");
    expect(env).toContain("Develop apps");
    expect(env).toContain("\n# MEMORY_DB_URL=\n"); // optional: default applies unless uncommented
    expect(env).not.toContain("\nMEMORY_DB_URL=");
    expect(env).toContain("\n# SESSION_PROFILE_DB_URL=\n"); // M13: on by default, optional to override
    expect(env).not.toContain("KNOWLEDGE_DB_URL"); // M12: no RAG wiring left to need it
  });

  test(".gitignore excludes .env and .wappy/", () => {
    const gi = files.get(".gitignore")!;
    expect(gi).toContain(".env");
    expect(gi).toContain(".wappy/");
  });

  test("package.json is valid JSON, pins @wappy/* part versions, and includes the Shopify tools-openapi dep but no @libsql/client (M12: only the RAG-less skill needed it)", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.name).toBe("luna-and-co-bot");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@wappy/core"]).toBe("0.1.0");
    expect(pkg.dependencies["@wappy/harness"]).toBe("0.1.0");
    expect(pkg.dependencies["@wappy/tools-openapi"]).toBe("0.1.0");
    expect(pkg.dependencies["create-wappy"]).toBe("0.1.0"); // provides the `wappy` bin `npm run dev` needs
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeDefined();
    expect(pkg.dependencies["@libsql/client"]).toBeUndefined();
  });

  test("README documents every env var and the generated combo, no Skills line", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).toContain("SHOPIFY_STORE_DOMAIN");
    expect(readme).toContain("cp .env.sample .env");
    expect(readme).toContain("WHATSAPP_APP_SECRET");
    expect(readme).toContain("Memory:** local SQLite");
    expect(readme).toContain("session-profile.db");
    expect(readme).toMatch(/Model:\*\* openai/);
    expect(readme).toContain("wappy dev");
    expect(readme).not.toContain("Skills:**");
  });
});

describe("renderProject — model provider branches", () => {
  test.each([
    ["anthropic", "@ai-sdk/anthropic", "anthropic(", "ANTHROPIC_API_KEY"],
    ["gemini", "@ai-sdk/google", "google(", "GOOGLE_GENERATIVE_AI_API_KEY"],
    ["ollama", "ollama-ai-provider", "ollama(", "OLLAMA_BASE_URL"],
  ] as const)("provider=%s imports %s and requires %s", (provider, pkg, ctorPrefix, envVar) => {
    const files = fileMap(renderProject({ answers: complete({ model: { provider } }), versions: VERSIONS }));
    expect(files.get("index.ts")).toContain(`from "${pkg}"`);
    expect(files.get("index.ts")).toContain(ctorPrefix);
    expect(files.get(".env.sample")).toContain(`${envVar}=`);
  });
});

describe("renderProject — WhatsApp credentials are never asked for", () => {
  test("every project lists the four WhatsApp keys, blank, in .env.sample — whatever else was chosen", () => {
    for (const answers of [complete(), complete({ tools: { kind: "shopify" } }), complete({ model: { provider: "ollama" } })]) {
      const env = fileMap(renderProject({ answers, versions: VERSIONS })).get(".env.sample")!;
      for (const key of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) expect(env).toContain(`\n${key}=\n`);
    }
  });
});

describe("renderProject — Shopify tool wiring supports a test-only local override", () => {
  test("tools/shopify.ts reads SHOPIFY_GRAPHQL_URL_OVERRIDE (for pointing at a mock server) but the key never appears in .env.sample", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "shopify" } }), versions: VERSIONS }));
    expect(files.get("tools/shopify.ts")).toContain("SHOPIFY_GRAPHQL_URL_OVERRIDE");
    expect(files.get(".env.sample")).not.toContain("SHOPIFY_GRAPHQL_URL_OVERRIDE");
  });
});

describe("renderProject — tools variants", () => {
  test("tools: none renders no tools/*.ts file and no tool-invocation wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "none" } }), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("tools/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("invokeTools");
    expect(JSON.parse(files.get("package.json")!).dependencies["@wappy/tools-openapi"]).toBeUndefined();
  });
});

describe("renderProject — no skills, ever (M12)", () => {
  test("no store connected: no skills/*.ts files and no skill registry wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete(), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("skills/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("createSkillRegistry");
  });

  test("Shopify connected: tools are wired, skills still never appear", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "shopify" } }), versions: VERSIONS }));
    expect(files.has("tools/shopify.ts")).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith("skills/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("createSkillRegistry");
  });
});

describe("renderProject — incomplete answers refused", () => {
  test("throws if any interview step is still unanswered", () => {
    const partial = { model: { provider: "openai" as const } };
    expect(() => renderProject({ answers: partial as CompleteInterviewAnswers, versions: VERSIONS })).toThrow(/incomplete/);
  });
});
