import type { CompleteInterviewAnswers, ModelProvider, ReferenceSkillName, ToolsAnswer } from "./interview.js";
import { assertComplete, skillsOf } from "./interview.js";

/**
 * T9.3 generators (SPEC.md §4.1 output: `index.ts`, `tools/*.ts`, `skills/*.ts`, `.env.sample`,
 * `.gitignore`, `README.md`, `package.json`) — see the session decision this follows: enum-driven
 * choices (model/framework/memory/router) are rendered by picking between pre-written, already-
 * shipped code paths (a `switch` selecting a one-line adapter constructor), never freshly invented
 * per choice; API-shape-driven tools (OpenAPI/Shopify) are a thin config wrapper around the real
 * runtime engines built in M7/M8 (parsing happens when the GENERATED app boots, not here); the one
 * genuinely dynamic piece (a store-specific skill draft) is passed in as an already-computed value
 * via `storeSkillDrafts`, keeping this whole module pure — no I/O, no model calls, fully
 * snapshot-testable (T9.8 builds on this).
 *
 * Memory (local LibSQL file) and the router (LLM) are fixed in v0.1 — the interview no longer offers
 * alternatives that aren't implemented, so there is nothing here that can fail at generation time
 * for lack of code. `.env.sample` is the single place every credential goes; the interview never
 * asks for one.
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  /** Section heading in `.env.sample`. */
  group: string;
}

/** Version strings for this project's own npm packages, resolved by the caller (e.g. read from
 * each package's own `package.json` at generation time) — kept out of this pure module, which never
 * touches the filesystem. */
export interface PartVersions {
  core: string;
  harness: string;
  whatsapp: string;
  toolsOpenapi: string;
  /** create-wappy's own version — needed as a generated project's OWN dependency (not just a
   * scaffolding tool) so `npm run dev`/`status`/`doctor` can resolve the `wappy` bin it provides. */
  createWappy: string;
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
        envVars: [{ name: "OPENAI_API_KEY", required: true, group: "Model", description: "OpenAI API key — create one at https://platform.openai.com/api-keys" }],
      };
    case "anthropic":
      return {
        importLine: 'import { anthropic } from "@ai-sdk/anthropic";',
        constructorExpr: 'anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")',
        envVars: [{ name: "ANTHROPIC_API_KEY", required: true, group: "Model", description: "Anthropic API key — create one at https://console.anthropic.com/settings/keys" }],
      };
    case "gemini":
      return {
        importLine: 'import { google } from "@ai-sdk/google";',
        constructorExpr: 'google(process.env.GEMINI_MODEL ?? "gemini-2.0-flash")',
        envVars: [{ name: "GOOGLE_GENERATIVE_AI_API_KEY", required: true, group: "Model", description: "Google AI Studio API key — create one at https://aistudio.google.com/apikey" }],
      };
    case "ollama":
      return {
        importLine: 'import { ollama } from "ollama-ai-provider";',
        constructorExpr: 'ollama(process.env.OLLAMA_MODEL ?? "llama3.1")',
        envVars: [{ name: "OLLAMA_BASE_URL", required: false, group: "Model", description: "Local Ollama server URL. Default: http://localhost:11434 (no API key needed)." }],
      };
  }
}

/** Conversation memory: a local LibSQL (SQLite) file — the only backend in v0.1. */
const MEMORY_ENV: EnvVarSpec = {
  name: "MEMORY_DB_URL",
  required: false,
  group: "Memory",
  description: "LibSQL URL for conversation memory. Default: a local file at .wappy/memory.db (nothing to set).",
};

interface ToolsSetup {
  importLine: string;
  /** A complete expression evaluating to a `ToolProvider`, used as-is at every call site. */
  providerExpr: string;
  envVars: EnvVarSpec[];
  fileName: string;
}

function toolsSetup(tools: ToolsAnswer): ToolsSetup | undefined {
  if (tools.kind === "none") return undefined;
  return {
    importLine: 'import { createShopifyToolProvider } from "@wappy/tools-openapi";',
    // SHOPIFY_GRAPHQL_URL_OVERRIDE is undocumented-to-end-users on purpose (not in .env.sample): it
    // exists so this exact generated code can be pointed at a local mock Shopify server for
    // testing, without touching real store credentials. Real installs never set it.
    providerExpr:
      'createShopifyToolProvider({ storeDomain: process.env.SHOPIFY_STORE_DOMAIN!, accessTokenEnvVar: "SHOPIFY_ACCESS_TOKEN", graphqlUrlOverride: process.env.SHOPIFY_GRAPHQL_URL_OVERRIDE, ssrf: process.env.SHOPIFY_GRAPHQL_URL_OVERRIDE ? { allowPrivateNetworks: true } : undefined })',
    fileName: "shopify",
    envVars: [
      { name: "SHOPIFY_STORE_DOMAIN", required: true, group: "Shopify", description: 'Your store domain, e.g. "my-shop.myshopify.com".' },
      { name: "SHOPIFY_ACCESS_TOKEN", required: true, group: "Shopify", description: "Admin API access token: Shopify admin > Settings > Apps and sales channels > Develop apps > create a custom app, grant read scopes (products, orders, inventory, customers), install it, then copy the token." },
    ],
  };
}

const SKILL_IMPORT_NAMES: Record<ReferenceSkillName, string> = { "store-info": "STORE_INFO_SKILL", orders: "createOrdersSkill" };

function renderIndexTs(opts: RenderProjectOptions): string {
  const { answers } = opts;
  const model = modelSetup(answers.model.provider);
  const tools = toolsSetup(answers.tools);
  const skills = skillsOf(answers);

  const harnessImports = new Set<string>(["createAgent", "createVercelModel", "createLibsqlMemory", "createLlmRouter"]);
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
  lines.push('import { createInMemoryTracer, systemClock } from "@wappy/core";');
  if (skills.includes("store-info")) lines.push('import { createClient } from "@libsql/client";');
  lines.push(`import { ${[...harnessImports].sort().join(", ")} } from "@wappy/harness";`);
  lines.push('import { createWhatsAppChannel } from "@wappy/whatsapp";');
  lines.push(model.importLine);
  if (tools) lines.push(tools.importLine);
  lines.push("");

  lines.push(`const model = createVercelModel({ model: ${model.constructorExpr} });`);
  lines.push('const memory = createLibsqlMemory({ url: process.env.MEMORY_DB_URL ?? "file:.wappy/memory.db" });');
  lines.push("const router = createLlmRouter({ model });");
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

  // Exported (not just used locally): `wappy dev` (T9.7) needs channel.receive() to turn a raw
  // webhook into InboundMessages before it can call agent.handle() on each one — the Agent itself
  // only exposes handle(), not receive(), since receiving isn't an agent concern.
  lines.push("export const channel = createWhatsAppChannel({");
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

/** WhatsApp Cloud API credentials — never asked in the interview; always listed in `.env.sample`. */
const WHATSAPP_ENV: EnvVarSpec[] = [
  { name: "WHATSAPP_PHONE_NUMBER_ID", required: true, group: "WhatsApp", description: "Meta developer app > WhatsApp > API Setup > Phone number ID." },
  { name: "WHATSAPP_ACCESS_TOKEN", required: true, group: "WhatsApp", description: "Meta developer app > WhatsApp > API Setup > access token (the temporary one expires in 24h; create a System User token for production)." },
  { name: "WHATSAPP_VERIFY_TOKEN", required: true, group: "WhatsApp", description: "Any string you choose (e.g. a random password). Enter the same value in Meta's webhook config." },
  { name: "WHATSAPP_APP_SECRET", required: true, group: "WhatsApp", description: "Meta developer app > App settings > Basic > App secret. Used to verify webhook signatures, so forged requests are rejected." },
];

/** Every env var the generated project needs, in `.env.sample` order. Exposed for the ledger-driven
 * orchestrator (`generate.ts`), which declares the `.env.sample` step's `SetupManifest.envKeys`
 * from it — one source of truth rather than re-deriving it. */
export function collectEnvVars(opts: RenderProjectOptions): EnvVarSpec[] {
  const { answers } = opts;
  const vars: EnvVarSpec[] = [...modelSetup(answers.model.provider).envVars, ...WHATSAPP_ENV];
  const tools = toolsSetup(answers.tools);
  if (tools) vars.push(...tools.envVars);
  vars.push(MEMORY_ENV);
  if (skillsOf(answers).includes("store-info")) {
    vars.push({ name: "KNOWLEDGE_DB_URL", required: false, group: "Memory", description: "LibSQL URL for the store-info knowledge base. Default: a local file at .wappy/knowledge.db (nothing to set)." });
  }
  return vars;
}

/** `.env.sample`: copy to `.env` and fill in. Grouped by concern; required keys are left blank,
 * optional ones are commented out so the default applies unless the user opts in. */
function renderEnvSample(opts: RenderProjectOptions): string {
  const vars = collectEnvVars(opts);
  const groups: string[] = [];
  for (const v of vars) if (!groups.includes(v.group)) groups.push(v.group);
  const out: string[] = [
    "# Copy this file to .env and fill in the values. Never commit .env (it is git-ignored).",
    "# Lines starting with # and a KEY are optional: uncomment to override the default.",
    "",
  ];
  for (const g of groups) {
    out.push(`# ── ${g} ${"─".repeat(Math.max(3, 60 - g.length))}`);
    for (const v of vars.filter((x) => x.group === g)) {
      out.push(`# ${v.description}`);
      out.push(v.required ? `${v.name}=` : `# ${v.name}=`);
    }
    out.push("");
  }
  return out.join("\n");
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
    // Provides the `wappy` bin (dev/status/reset/doctor) that this project's own scripts invoke —
    // a real runtime dependency here, not just the one-time scaffolder.
    "create-wappy": versions.createWappy,
    ai: "^7.0.0",
    dotenv: "^17.0.0",
  };
  const modelDep = THIRD_PARTY_VERSIONS[answers.model.provider];
  deps[modelDep.pkg] = modelDep.range;
  if (answers.tools.kind !== "none") {
    deps["@wappy/tools-openapi"] = versions.toolsOpenapi;
  }
  if (skillsOf(answers).includes("store-info")) {
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
  const skills = skillsOf(answers);
  const lines: string[] = [];
  lines.push(`# ${opts.projectName ?? "wappy-bot"}`);
  lines.push("");
  lines.push("A WhatsApp agent generated by `create-wappy`.");
  lines.push("");
  lines.push("## 1. Add your credentials");
  lines.push("");
  lines.push("```sh");
  lines.push("cp .env.sample .env   # then fill in every key that has no default");
  lines.push("```");
  lines.push("");
  lines.push("`.env` is git-ignored — secrets never leave your machine. Where to get each key:");
  lines.push("");
  for (const v of vars) lines.push(`- \`${v.name}\`${v.required ? "" : " (optional)"} — ${v.description}`);
  lines.push("");
  lines.push("## 2. Connect WhatsApp");
  lines.push("");
  lines.push("1. Create a Meta developer app at https://developers.facebook.com/apps and add the WhatsApp product.");
  lines.push("2. Copy the phone number ID, access token and app secret into `.env` (see the list above).");
  lines.push("3. Choose any string as `WHATSAPP_VERIFY_TOKEN` — you enter the same value on both sides.");
  lines.push("4. Run `wappy dev` — it prints a public webhook URL. Paste that URL + your verify token into the app's webhook config.");
  lines.push("");
  lines.push("## 3. What was generated");
  lines.push("");
  lines.push(`- **Model:** ${answers.model.provider}`);
  lines.push("- **Memory:** local SQLite file (`.wappy/memory.db`)");
  lines.push(`- **Tools:** ${answers.tools.kind === "shopify" ? "Shopify" : "none"}`);
  lines.push(`- **Skills:** ${skills.length > 0 ? skills.join(", ") : "none"}`);
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
  for (const s of skillsOf(opts.answers)) {
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
    { path: ".env.sample", content: renderEnvSample(opts) },
    { path: ".gitignore", content: renderGitignore() },
    { path: "package.json", content: renderPackageJson(opts) },
    { path: "README.md", content: renderReadme(opts) },
  ];
  const toolsFile = renderToolsFile(opts);
  if (toolsFile) files.push(toolsFile);
  files.push(...renderSkillFiles(opts));
  return files;
}
