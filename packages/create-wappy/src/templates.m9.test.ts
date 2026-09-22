import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions, type RenderProjectOptions } from "./templates.js";

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" };

function complete(overrides: Partial<InterviewAnswers> = {}): CompleteInterviewAnswers {
  const model = overrides.model ?? DEFAULT_ANSWERS.model;
  const tools = overrides.tools ?? DEFAULT_ANSWERS.tools;
  // skills only exist on the Shopify path (the interview never asks otherwise)
  return tools.kind === "shopify" ? { model, tools, skills: overrides.skills ?? DEFAULT_ANSWERS.skills } : { model, tools };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("renderProject — golden path (openai + shopify + store-info/orders)", () => {
  const opts: RenderProjectOptions = {
    answers: complete({
      model: { provider: "openai" },
      skills: { skills: ["store-info", "orders"] },
      tools: { kind: "shopify" },
    }),
    versions: VERSIONS,
    projectName: "luna-and-co-bot",
  };
  const files = fileMap(renderProject(opts));

  test("renders exactly the §4.1-listed output files, plus per-tool/per-skill files", () => {
    expect([...files.keys()].sort()).toEqual(["README.md", ".env.sample", ".gitignore", "index.ts", "package.json", "skills/orders.ts", "skills/store-info.ts", "tools/shopify.ts"].sort());
  });

  test("index.ts imports the OpenAI adapter and wires model/memory/router/tools/skills/rag/channel", () => {
    const indexTs = files.get("index.ts")!;
    expect(indexTs).toContain('import { openai } from "@ai-sdk/openai";');
    expect(indexTs).toContain('openai(process.env.OPENAI_MODEL ?? "gpt-4o")');
    expect(indexTs).toContain("createLibsqlMemory");
    expect(indexTs).toContain("createLlmRouter({ model })");
    expect(indexTs).toContain("const toolProvider = createShopifyToolProvider(");
    expect(indexTs).toContain("const invokeTools = createToolInvoker({ model, tools });");
    expect(indexTs).toContain("const knowledge = createKnowledge(");
    expect(indexTs).toContain("const retrieveRag = createKnowledgeRag(");
    expect(indexTs).toContain("skills.register(STORE_INFO_SKILL);");
    expect(indexTs).toContain("skills.register(createOrdersSkill());");
    expect(indexTs).toContain("createWhatsAppChannel({");
    expect(indexTs).toContain("export const agent = createAgent({");
  });

  test("tools/shopify.ts wires the real Shopify connector with the domain read from env", () => {
    const toolsFile = files.get("tools/shopify.ts")!;
    expect(toolsFile).toContain('import { createShopifyToolProvider } from "@wappy/tools-openapi";');
    expect(toolsFile).toContain("storeDomain: process.env.SHOPIFY_STORE_DOMAIN!");
  });

  test("skills/*.ts import the static reference skills verbatim (no draft supplied)", () => {
    expect(files.get("skills/store-info.ts")).toContain('export { STORE_INFO_SKILL as storeInfoSkill } from "@wappy/harness";');
    expect(files.get("skills/orders.ts")).toContain("createOrdersSkill()");
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
  });

  test(".gitignore excludes .env and .wappy/", () => {
    const gi = files.get(".gitignore")!;
    expect(gi).toContain(".env");
    expect(gi).toContain(".wappy/");
  });

  test("package.json is valid JSON, pins @wappy/* part versions, and includes the Shopify tools-openapi + provider deps", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.name).toBe("luna-and-co-bot");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@wappy/core"]).toBe("0.1.0");
    expect(pkg.dependencies["@wappy/harness"]).toBe("0.1.0");
    expect(pkg.dependencies["@wappy/tools-openapi"]).toBe("0.1.0");
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeDefined();
    expect(pkg.dependencies["@libsql/client"]).toBeDefined(); // store-info needs Knowledge's LibSQL client
  });

  test("README documents every env var and the generated combo", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).toContain("SHOPIFY_STORE_DOMAIN");
    expect(readme).toContain("cp .env.sample .env");
    expect(readme).toContain("WHATSAPP_APP_SECRET");
    expect(readme).toContain("Memory:** local SQLite");
    expect(readme).toMatch(/Model:\*\* openai/);
    expect(readme).toContain("wappy dev");
  });
});

describe("renderProject — store-specific skill drafts are embedded, not the static import", () => {
  test("a generateStoreSkill()-style draft is inlined as an object literal overriding promptFragment", () => {
    const opts: RenderProjectOptions = {
      answers: complete({ skills: { skills: ["store-info"] }, tools: { kind: "shopify" } }),
      versions: VERSIONS,
      storeSkillDrafts: { "store-info": { promptFragment: "You can help with candles, 45-day returns, and 2-3 day shipping." } },
    };
    const files = fileMap(renderProject(opts));
    const skillFile = files.get("skills/store-info.ts")!;
    expect(skillFile).toContain("...STORE_INFO_SKILL");
    expect(skillFile).toContain(JSON.stringify("You can help with candles, 45-day returns, and 2-3 day shipping."));
    expect(files.get("index.ts")).toContain("...STORE_INFO_SKILL");
  });

  test("a draft for the orders skill is inlined over createOrdersSkill(), with an overridden description too", () => {
    const files = fileMap(
      renderProject({
        answers: complete({ skills: { skills: ["orders"] }, tools: { kind: "shopify" } }),
        versions: VERSIONS,
        storeSkillDrafts: { orders: { promptFragment: "Look up Luna & Co. orders.", description: "Luna & Co. order lookups." } },
      }),
    );
    const skillFile = files.get("skills/orders.ts")!;
    expect(skillFile).toContain("...createOrdersSkill()");
    expect(skillFile).toContain(JSON.stringify("Look up Luna & Co. orders."));
    expect(skillFile).toContain(JSON.stringify("Luna & Co. order lookups."));
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

describe("renderProject — .env.sample covers every env var the generated code reads", () => {
  test("the store-info skill adds its optional KNOWLEDGE_DB_URL (commented out); without it the key is absent", () => {
    const withSkill = fileMap(renderProject({ answers: complete({ tools: { kind: "shopify" }, skills: { skills: ["store-info"] } }), versions: VERSIONS }));
    expect(withSkill.get("index.ts")).toContain("KNOWLEDGE_DB_URL");
    expect(withSkill.get(".env.sample")).toContain("\n# KNOWLEDGE_DB_URL=\n");
    const without = fileMap(renderProject({ answers: complete({ tools: { kind: "shopify" }, skills: { skills: ["orders"] } }), versions: VERSIONS }));
    expect(without.get(".env.sample")).not.toContain("KNOWLEDGE_DB_URL");
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

describe("renderProject — tools variants", () => {
  test("tools: none renders no tools/*.ts file and no tool-invocation wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "none" } }), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("tools/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("invokeTools");
    expect(JSON.parse(files.get("package.json")!).dependencies["@wappy/tools-openapi"]).toBeUndefined();
  });
});

describe("renderProject — skills", () => {
  test("no store connected: no skills/*.ts files and no skill registry wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete(), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("skills/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("createSkillRegistry");
    expect(files.get("README.md")).toContain("Skills:** none");
  });

  test("Shopify connected but no skills picked: tools are wired, skills are not", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "shopify" }, skills: { skills: [] } }), versions: VERSIONS }));
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
