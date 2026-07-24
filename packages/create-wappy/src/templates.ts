import type { CompleteInterviewAnswers, FrameworkChoice, MemoryBackend, ModelProvider, ReferenceSkillName, RouterAnswer, ToolsAnswer } from "./interview.js";
import { assertComplete } from "./interview.js";

/**
 * T9.3 generators (SPEC.md §4.1 output: `index.ts`, `tools/*.ts`, `skills/*.ts`, `.env.example`,
 * `.gitignore`, `README.md`, `package.json`) — see the session decision this follows: enum-driven
 * choices (model/framework/memory/router) are rendered by picking between pre-written, already-
 * shipped code paths (a `switch` selecting a one-line adapter constructor), never freshly invented
 * per choice; API-shape-driven tools (OpenAPI/Shopify) are a thin config wrapper around the real
 * runtime engines built in M7/M8 (parsing happens when the GENERATED app boots, not here); the one
 * genuinely dynamic piece (a store-specific skill draft) is passed in as an already-computed value
 * via `storeSkillDrafts`, keeping this whole module pure — no I/O, no model calls, fully
 * snapshot-testable (T9.8 builds on this).
 *
 * Every enum branch not yet backed by real code (non-"none" framework — T9.4; non-"local" memory
 * and the "jev" router — M10) throws `NotYetImplementedError` at GENERATION time rather than
 * emitting code that would fail at runtime — matches this codebase's established "fail loud at
 * install, not runtime" convention (§10).
 */

export class NotYetImplementedError extends Error {}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
}

/** Version strings for this project's own npm packages, resolved by the caller (e.g. read from
 * each package's own `package.json` at generation time) — kept out of this pure module, which never
 * touches the filesystem. */
export interface PartVersions {
  core: string;
  harness: string;
  whatsapp: string;
  toolsOpenapi: string;
}

/** A store-specific skill draft, e.g. from `@wappy/harness`'s `generateStoreSkill()` — computed
 * once, by the CALLER, before rendering; this module only ever embeds the already-computed string. */
export interface StoreSkillDraft {
  description?: string;
  promptFragment: string;
}

export interface RenderProjectOptions {
  answers: CompleteInterviewAnswers;
  versions: PartVersions;
  projectName?: string;
  /** Keyed by reference skill name (e.g. "store-info"). A skill with no draft here renders its
   * static reference-skill text verbatim (imported from `@wappy/harness`, not inlined). */
  storeSkillDrafts?: Partial<Record<ReferenceSkillName, StoreSkillDraft>>;
}

interface ModelSetup {
  importLine: string;
  constructorExpr: string;
  envVars: EnvVarSpec[];
}

function modelSetup(provider: ModelProvider): ModelSetup {
  switch (provider) {
    case "openai":
      return {
        importLine: 'import { openai } from "@ai-sdk/openai";',
        constructorExpr: 'openai(process.env.OPENAI_MODEL ?? "gpt-4o")',
        envVars: [{ name: "OPENAI_API_KEY", required: true, description: "Your OpenAI API key." }],
      };
    case "anthropic":
      return {
        importLine: 'import { anthropic } from "@ai-sdk/anthropic";',
        constructorExpr: 'anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")',
        envVars: [{ name: "ANTHROPIC_API_KEY", required: true, description: "Your Anthropic API key." }],
      };
    case "gemini":
      return {
        importLine: 'import { google } from "@ai-sdk/google";',
        constructorExpr: 'google(process.env.GEMINI_MODEL ?? "gemini-2.0-flash")',
        envVars: [{ name: "GOOGLE_GENERATIVE_AI_API_KEY", required: true, description: "Your Google AI Studio API key." }],
      };
    case "ollama":
      return {
        importLine: 'import { ollama } from "ollama-ai-provider";',
        constructorExpr: 'ollama(process.env.OLLAMA_MODEL ?? "llama3.1")',
        envVars: [{ name: "OLLAMA_BASE_URL", required: false, description: "Local Ollama server URL (default http://localhost:11434)." }],
      };
  }
}

interface MemorySetup {
  importLine: string;
  constructorExpr: string;
  envVars: EnvVarSpec[];
}

function memorySetup(backend: MemoryBackend): MemorySetup {
  if (backend !== "local") {
    throw new NotYetImplementedError(`Memory backend "${backend}" isn't implemented yet (coming in M10). Choose "local" for now.`);
  }
  return {
    importLine: 'import { createLibsqlMemory } from "@wappy/harness";',
    constructorExpr: 'createLibsqlMemory({ url: process.env.MEMORY_DB_URL ?? "file:.wappy/memory.db" })',
    envVars: [{ name: "MEMORY_DB_URL", required: false, description: "LibSQL URL for conversation memory (default: a local file under .wappy/)." }],
  };
}

interface RouterSetup {
  importLine: string;
  constructorExpr: string;
}

function routerSetup(router: RouterAnswer): RouterSetup {
  if (router.router !== "llm") {
    throw new NotYetImplementedError(`Router "${router.router}" isn't implemented yet (coming in M10). Choose "llm" for now.`);
  }
  return { importLine: 'import { createLlmRouter } from "@wappy/harness";', constructorExpr: "createLlmRouter({ model })" };
}

function assertFrameworkSupported(framework: FrameworkChoice): void {
  if (framework !== "none") {
    throw new NotYetImplementedError(`Framework adapter stubs for "${framework}" aren't implemented yet (coming in a later step, T9.4). Choose "None" for now.`);
  }
}

interface ToolsSetup {
  importLine: string;
  /** A complete expression evaluating to a `ToolProvider` — already includes its own `await` when
   * needed (openapi), so every call site uses it as-is, never wrapping it in a further `await`. */
  providerExpr: string;
  envVars: EnvVarSpec[];
  fileName: string;
}

function toolsSetup(tools: ToolsAnswer): ToolsSetup | undefined {
  if (tools.kind === "none") return undefined;
  if (tools.kind === "shopify") {
    return {
      importLine: 'import { createShopifyToolProvider } from "@wappy/tools-openapi";',
      providerExpr: 'createShopifyToolProvider({ storeDomain: process.env.SHOPIFY_STORE_DOMAIN!, accessTokenEnvVar: "SHOPIFY_ACCESS_TOKEN" })',
      fileName: "shopify",
      envVars: [
        { name: "SHOPIFY_STORE_DOMAIN", required: true, description: 'Your Shopify store domain, e.g. "my-shop.myshopify.com".' },
        { name: "SHOPIFY_ACCESS_TOKEN", required: true, description: "A custom-app access token from your Shopify admin." },
      ],
    };
  }
  // openapi
  return {
    importLine: 'import { createOpenApiToolProvider } from "@wappy/tools-openapi";',
    providerExpr: `(await createOpenApiToolProvider({ name: "api", source: ${JSON.stringify(tools.source)}, envPrefix: "API_" })).provider`,
    fileName: "api",
    envVars: [{ name: "API_API_KEY", required: false, description: "Auth credential(s) your OpenAPI spec requires — see tools/api.ts for the exact env var name(s) after generation." }],
  };
}

const SKILL_IMPORT_NAMES: Record<ReferenceSkillName, string> = { "store-info": "STORE_INFO_SKILL", orders: "createOrdersSkill" };

function renderIndexTs(opts: RenderProjectOptions): string {
  const { answers } = opts;
  assertFrameworkSupported(answers.framework.framework);
  const model = modelSetup(answers.model.provider);
  const memory = memorySetup(answers.memory.backend);
  const router = routerSetup(answers.router);
  const tools = toolsSetup(answers.tools);
  const skills = answers.skills.skills;

  // memorySetup/routerSetup only ever return their "local"/"llm" shape today (anything else already
  // threw above), so their imports are named directly here rather than parsed back out of them.
  const harnessImports = new Set<string>(["createAgent", "createVercelModel", "createLibsqlMemory", "createLlmRouter", "createInMemoryTracer"]);
  if (skills.length > 0) harnessImports.add("createSkillRegistry");
  for (const s of skills) harnessImports.add(SKILL_IMPORT_NAMES[s]);
  if (skills.includes("store-info")) {
    harnessImports.add("createKnowledge");
    harnessImports.add("createKnowledgeRag");
  }
  if (tools) {
    harnessImports.add("createToolInvoker");
  }

  const lines: string[] = [];
  lines.push('import "dotenv/config";');
  lines.push('import { systemClock } from "@wappy/core";');
  if (skills.includes("store-info")) lines.push('import { createClient } from "@libsql/client";');
  lines.push(`import { ${[...harnessImports].sort().join(", ")} } from "@wappy/harness";`);
  lines.push('import { createWhatsAppChannel } from "@wappy/whatsapp";');
  lines.push(model.importLine);
  if (tools) lines.push(tools.importLine);
  lines.push("");

  lines.push(`const model = createVercelModel({ model: ${model.constructorExpr} });`);
  lines.push(`const memory = ${memory.constructorExpr};`);
  lines.push(`const router = ${router.constructorExpr};`);
  lines.push("const tracer = createInMemoryTracer();");
  lines.push("");

  if (tools) {
    lines.push(`const toolProvider = ${tools.providerExpr};`);
    lines.push("const tools = toolProvider.listTools();");
    lines.push("const invokeTools = createToolInvoker({ model, tools });");
    lines.push("");
  }

  if (skills.includes("store-info")) {
    lines.push('const knowledge = createKnowledge({ client: createClient({ url: process.env.KNOWLEDGE_DB_URL ?? "file:.wappy/knowledge.db" }) });');
    lines.push("const retrieveRag = createKnowledgeRag({ knowledge });");
    lines.push("");
  }

  if (skills.length > 0) {
    lines.push("const skills = createSkillRegistry();");
    for (const s of skills) {
      const draft = opts.storeSkillDrafts?.[s];
      if (s === "store-info") {
        lines.push(draft ? `skills.register(${renderInlineSkill("store-info", draft)});` : "skills.register(STORE_INFO_SKILL);");
      } else {
        lines.push(draft ? `skills.register(${renderInlineSkill("orders", draft, "createOrdersSkill()")});` : "skills.register(createOrdersSkill());");
      }
    }
    lines.push("");
  }

  lines.push("const channel = createWhatsAppChannel({");
  lines.push("  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,");
  lines.push("  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,");
  lines.push("  clock: systemClock,");
  lines.push("});");
  lines.push("");

  lines.push("export const agent = createAgent({");
  lines.push("  channel, memory, router, model, tracer,");
  lines.push("  clock: systemClock,");
  if (skills.length > 0) lines.push("  skills,");
  if (skills.includes("store-info")) lines.push("  retrieveRag,");
  if (tools) {
    lines.push("  tools,");
    lines.push("  invokeTools,");
  }
  lines.push("});");
  lines.push("");

  return lines.join("\n");
}

/** Embeds an already-computed skill draft (e.g. from `generateStoreSkill()`) as an inline object
 * literal — spreads over the static reference skill's `tools`/`memorySchema` (via the base
 * expression, when given) so only `description`/`promptFragment` actually change. */
function renderInlineSkill(name: ReferenceSkillName, draft: StoreSkillDraft, baseExpr?: string): string {
  const overrides: string[] = [`promptFragment: ${JSON.stringify(draft.promptFragment)}`];
  if (draft.description) overrides.push(`description: ${JSON.stringify(draft.description)}`);
  return baseExpr ? `{ ...${baseExpr}, ${overrides.join(", ")} }` : `{ ...STORE_INFO_SKILL, ${overrides.join(", ")} }`;
}

/** Exposed for the ledger-driven orchestrator (`generate.ts`), which needs the same env-var list to
 * declare the `.env.example` step's `SetupManifest.envKeys` — kept as one source of truth rather
 * than re-deriving it. */
export function collectEnvVars(opts: RenderProjectOptions): EnvVarSpec[] {
  const { answers } = opts;
  const vars: EnvVarSpec[] = [...modelSetup(answers.model.provider).envVars, ...memorySetup(answers.memory.backend).envVars];
  const tools = toolsSetup(answers.tools);
  if (tools) vars.push(...tools.envVars);
  if (answers.whatsapp.mode === "now") {
    vars.push(
      { name: "WHATSAPP_PHONE_NUMBER_ID", required: true, description: "Your WhatsApp Cloud API phone number id." },
      { name: "WHATSAPP_ACCESS_TOKEN", required: true, description: "Your WhatsApp Cloud API access token." },
      { name: "WHATSAPP_VERIFY_TOKEN", required: true, description: "A token you choose — used to verify the webhook with Meta." },
    );
  } else {
    vars.push(
      { name: "WHATSAPP_PHONE_NUMBER_ID", required: true, description: "Fill in once you have WhatsApp Cloud API credentials — see README." },
      { name: "WHATSAPP_ACCESS_TOKEN", required: true, description: "Fill in once you have WhatsApp Cloud API credentials — see README." },
      { name: "WHATSAPP_VERIFY_TOKEN", required: true, description: "Fill in once you have WhatsApp Cloud API credentials — see README." },
    );
  }
  return vars;
}

function renderEnvExample(opts: RenderProjectOptions): string {
  const vars = collectEnvVars(opts);
  const lines = vars.map((v) => `# ${v.description}${v.required ? "" : " (optional)"}\n${v.name}=`);
  return `${lines.join("\n\n")}\n`;
}

function renderGitignore(): string {
  return ["node_modules/", ".env", ".wappy/", "dist/", ""].join("\n");
}

const THIRD_PARTY_VERSIONS: Record<ModelProvider, { pkg: string; range: string }> = {
  openai: { pkg: "@ai-sdk/openai", range: "^2.0.0" },
  anthropic: { pkg: "@ai-sdk/anthropic", range: "^2.0.0" },
  gemini: { pkg: "@ai-sdk/google", range: "^2.0.0" },
  ollama: { pkg: "ollama-ai-provider", range: "^1.2.0" },
};

function renderPackageJson(opts: RenderProjectOptions): string {
  const { answers, versions, projectName } = opts;
  const deps: Record<string, string> = {
    "@wappy/core": versions.core,
    "@wappy/harness": versions.harness,
    "@wappy/whatsapp": versions.whatsapp,
    ai: "^7.0.0",
    dotenv: "^17.0.0",
  };
  const modelDep = THIRD_PARTY_VERSIONS[answers.model.provider];
  deps[modelDep.pkg] = modelDep.range;
  if (answers.tools.kind !== "none") {
    deps["@wappy/tools-openapi"] = versions.toolsOpenapi;
  }
  if (answers.skills.skills.includes("store-info")) {
    deps["@libsql/client"] = "^0.18.0";
  }
  const pkg = {
    name: projectName ?? "wappy-bot",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { dev: "wappy dev", start: "node index.js" },
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function renderReadme(opts: RenderProjectOptions): string {
  const { answers } = opts;
  const vars = collectEnvVars(opts);
  const lines: string[] = [];
  lines.push(`# ${opts.projectName ?? "wappy-bot"}`);
  lines.push("");
  lines.push("A WhatsApp agent generated by `create-wappy`. Fill in the env keys below, then run `wappy dev`.");
  lines.push("");
  lines.push("## 1. Getting WhatsApp Cloud API credentials");
  lines.push("");
  lines.push("1. Create a Meta developer app at https://developers.facebook.com/apps and add the WhatsApp product.");
  lines.push("2. From the app's WhatsApp > API Setup page, copy the **temporary access token** and **phone number ID**.");
  lines.push('3. Pick any string as your **verify token** (e.g. a random password) — you\'ll enter the same value on both sides.');
  lines.push("4. Run `wappy dev` — it prints a public webhook URL. Paste that URL + your verify token into the app's webhook config.");
  lines.push("");
  lines.push("## 2. Env keys");
  lines.push("");
  for (const v of vars) lines.push(`- \`${v.name}\`${v.required ? "" : " (optional)"} — ${v.description}`);
  lines.push("");
  lines.push("## 3. What was generated");
  lines.push("");
  lines.push(`- **Model:** ${answers.model.provider}`);
  lines.push(`- **Memory:** ${answers.memory.backend}`);
  lines.push(`- **Router:** ${answers.router.router}`);
  lines.push(`- **Tools:** ${answers.tools.kind}`);
  lines.push(`- **Skills:** ${answers.skills.skills.length > 0 ? answers.skills.skills.join(", ") : "none"}`);
  lines.push(`- **WhatsApp:** ${answers.whatsapp.mode === "now" ? "credentials entered during setup" : "deferred — fill in .env yourself"}`);
  lines.push("");
  lines.push("Run `wappy status` any time to see what's done vs. pending, and `wappy doctor` to validate your env + connectivity.");
  lines.push("");
  return lines.join("\n");
}

function renderToolsFile(opts: RenderProjectOptions): GeneratedFile | undefined {
  const tools = toolsSetup(opts.answers.tools);
  if (!tools) return undefined;
  const lines: string[] = [tools.importLine, "", `export const toolProvider = ${tools.providerExpr};`, ""];
  return { path: `tools/${tools.fileName}.ts`, content: lines.join("\n") };
}

function renderSkillFiles(opts: RenderProjectOptions): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const s of opts.answers.skills.skills) {
    const draft = opts.storeSkillDrafts?.[s];
    if (s === "store-info") {
      files.push({
        path: "skills/store-info.ts",
        content: draft
          ? `import type { Skill } from "@wappy/core";\nimport { STORE_INFO_SKILL } from "@wappy/harness";\n\nexport const storeInfoSkill: Skill = ${renderInlineSkill("store-info", draft)};\n`
          : `export { STORE_INFO_SKILL as storeInfoSkill } from "@wappy/harness";\n`,
      });
    } else {
      files.push({
        path: "skills/orders.ts",
        content: draft
          ? `import type { Skill } from "@wappy/core";\nimport { createOrdersSkill } from "@wappy/harness";\n\nexport const ordersSkill: Skill = ${renderInlineSkill("orders", draft, "createOrdersSkill()")};\n`
          : `import { createOrdersSkill } from "@wappy/harness";\n\nexport const ordersSkill = createOrdersSkill();\n`,
      });
    }
  }
  return files;
}

/**
 * Renders every project file for a completed interview (§4.1's output list). Throws
 * `NotYetImplementedError` for any enum choice not yet backed by real code (see file header) —
 * callers (the CLI, in practice) should surface that as a clear install-time failure, not attempt
 * to generate broken code. Pure: no filesystem access, no model calls — see `generate.ts` (a later
 * T9.3 step) for the ledger-driven orchestrator that actually writes these to disk.
 */
export function renderProject(opts: RenderProjectOptions): GeneratedFile[] {
  assertComplete(opts.answers);
  const files: GeneratedFile[] = [
    { path: "index.ts", content: renderIndexTs(opts) },
    { path: ".env.example", content: renderEnvExample(opts) },
    { path: ".gitignore", content: renderGitignore() },
    { path: "package.json", content: renderPackageJson(opts) },
    { path: "README.md", content: renderReadme(opts) },
  ];
  const toolsFile = renderToolsFile(opts);
  if (toolsFile) files.push(toolsFile);
  files.push(...renderSkillFiles(opts));
  return files;
}
