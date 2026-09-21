import { describe, expect, test } from "vitest";
import { applyAnswer, DEFAULT_ANSWERS, type CompleteInterviewAnswers, type InterviewAnswers } from "./interview.js";
import { NotYetImplementedError, renderProject, type PartVersions, type RenderProjectOptions } from "./templates.js";

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" };

function complete(overrides: Partial<InterviewAnswers> = {}): CompleteInterviewAnswers {
  let answers: InterviewAnswers = {};
  for (const [step, value] of Object.entries(DEFAULT_ANSWERS)) {
    const r = applyAnswer(answers, step as keyof InterviewAnswers, (overrides as InterviewAnswers)[step as keyof InterviewAnswers] ?? value);
    if (!r.ok) throw new Error(`test setup: invalid answer for ${step}: ${r.errors.join(", ")}`);
    answers = r.answers;
  }
  return answers as CompleteInterviewAnswers;
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("renderProject — golden path (openai + shopify + store-info/orders + local + llm + later)", () => {
  const opts: RenderProjectOptions = {
    answers: complete({
      model: { provider: "openai" },
      skills: { skills: ["store-info", "orders"] },
      tools: { kind: "shopify", storeDomain: "luna-and-co.myshopify.com" },
    }),
    versions: VERSIONS,
    projectName: "luna-and-co-bot",
  };
  const files = fileMap(renderProject(opts));

  test("renders exactly the §4.1-listed output files, plus per-tool/per-skill files", () => {
    expect([...files.keys()].sort()).toEqual(["README.md", ".env.example", ".gitignore", "index.ts", "package.json", "skills/orders.ts", "skills/store-info.ts", "tools/shopify.ts"].sort());
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

  test("tools/shopify.ts wires the real Shopify connector with the store's own domain", () => {
    const toolsFile = files.get("tools/shopify.ts")!;
    expect(toolsFile).toContain('import { createShopifyToolProvider } from "@wappy/tools-openapi";');
    expect(toolsFile).toContain("storeDomain: process.env.SHOPIFY_STORE_DOMAIN!");
  });

  test("skills/*.ts import the static reference skills verbatim (no draft supplied)", () => {
    expect(files.get("skills/store-info.ts")).toContain('export { STORE_INFO_SKILL as storeInfoSkill } from "@wappy/harness";');
    expect(files.get("skills/orders.ts")).toContain("createOrdersSkill()");
  });

  test(".env.example lists placeholder keys only — never a real secret value", () => {
    const env = files.get(".env.example")!;
    expect(env).toContain("OPENAI_API_KEY=\n");
    expect(env).toContain("SHOPIFY_STORE_DOMAIN=\n");
    expect(env).toContain("SHOPIFY_ACCESS_TOKEN=\n");
    expect(env).toContain("WHATSAPP_PHONE_NUMBER_ID=\n");
    // No line looks like a filled-in secret (KEY=<something>) beyond the bare "KEY=" placeholder form.
    for (const line of env.split("\n").filter((l) => l.includes("="))) {
      expect(line.endsWith("=")).toBe(true);
    }
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
    expect(readme).toMatch(/Model:\*\* openai/);
    expect(readme).toContain("wappy dev");
  });
});

describe("renderProject — store-specific skill drafts are embedded, not the static import", () => {
  test("a generateStoreSkill()-style draft is inlined as an object literal overriding promptFragment", () => {
    const opts: RenderProjectOptions = {
      answers: complete({ skills: { skills: ["store-info"] }, tools: { kind: "shopify", storeDomain: "luna-and-co.myshopify.com" } }),
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
        answers: complete({ skills: { skills: ["orders"] } }),
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
    expect(files.get(".env.example")).toContain(`${envVar}=`);
  });
});

describe("renderProject — whatsapp mode=now still only writes placeholder keys to .env.example", () => {
  test("credential names are listed but no value from the interview answer leaks into .env.example", () => {
    const files = fileMap(
      renderProject({
        answers: complete({ whatsapp: { mode: "now", phoneNumberId: "106540352242922", accessToken: "EAA-real-secret-value", verifyToken: "my-real-verify-token" } }),
        versions: VERSIONS,
      }),
    );
    const env = files.get(".env.example")!;
    expect(env).toContain("WHATSAPP_ACCESS_TOKEN=\n");
    expect(env).not.toContain("EAA-real-secret-value");
    expect(env).not.toContain("my-real-verify-token");
    expect(files.get("README.md")).toContain("credentials entered during setup");
  });
});

describe("renderProject — tools variants", () => {
  test("tools: none renders no tools/*.ts file and no tool-invocation wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "none" } }), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("tools/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("invokeTools");
    expect(JSON.parse(files.get("package.json")!).dependencies["@wappy/tools-openapi"]).toBeUndefined();
  });

  test("tools: openapi renders an awaited provider and the source URL baked into tools/api.ts", () => {
    const files = fileMap(renderProject({ answers: complete({ tools: { kind: "openapi", source: "https://api.example.com/openapi.json" } }), versions: VERSIONS }));
    const toolsFile = files.get("tools/api.ts")!;
    expect(toolsFile).toContain("await createOpenApiToolProvider(");
    expect(toolsFile).toContain('"https://api.example.com/openapi.json"');
    const indexTs = files.get("index.ts")!;
    expect(indexTs).toContain("const toolProvider = (await createOpenApiToolProvider(");
    expect(indexTs).not.toMatch(/await \(await/); // no redundant double-await
  });
});

describe("renderProject — skills: none", () => {
  test("no skills/*.ts files and no skill registry wiring in index.ts", () => {
    const files = fileMap(renderProject({ answers: complete({ skills: { skills: [] } }), versions: VERSIONS }));
    expect([...files.keys()].some((p) => p.startsWith("skills/"))).toBe(false);
    expect(files.get("index.ts")).not.toContain("createSkillRegistry");
  });
});

describe("renderProject — not-yet-implemented combos fail loud at generation time", () => {
  test("a framework other than 'none' throws NotYetImplementedError", () => {
    expect(() => renderProject({ answers: complete({ framework: { framework: "mastra" } }), versions: VERSIONS })).toThrow(NotYetImplementedError);
  });

  test("a memory backend other than 'local' throws NotYetImplementedError", () => {
    expect(() => renderProject({ answers: complete({ memory: { backend: "mem0" } }), versions: VERSIONS })).toThrow(NotYetImplementedError);
  });

  test("the jev router throws NotYetImplementedError", () => {
    expect(() => renderProject({ answers: complete({ router: { router: "jev", jevKeyPath: "/keys/jev.json" } }), versions: VERSIONS })).toThrow(NotYetImplementedError);
  });
});

describe("renderProject — incomplete answers refused", () => {
  test("throws if any interview step is still unanswered", () => {
    const partial = { model: { provider: "openai" as const } };
    expect(() => renderProject({ answers: partial as CompleteInterviewAnswers, versions: VERSIONS })).toThrow(/incomplete/);
  });
});
