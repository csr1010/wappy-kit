import { describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_ANSWERS, renderProject, type RenderProjectOptions } from "create-wappy";

/**
 * Found by hand-testing the real installed CLI against a real registry (Verdaccio) instead of the
 * workspace: `renderProject()` generated `import { createInMemoryTracer } from "@wappy/harness"`,
 * but that function actually lives in `@wappy/core` — a generated project crashed on the very first
 * `import` with "does not provide an export named 'createInMemoryTracer'". No workspace test caught
 * it, because none of them load the generated code as a real module against the real built
 * packages; every unit test only does string-matching (`toContain(...)`) on the rendered source.
 *
 * This test closes that class of bug generically: for every combination `renderProject` can emit,
 * every `import { a, b, ... } from "@wappy/X"` in the generated `index.ts`/`tools/*.ts`/`skills/*.ts`
 * names only symbols `@wappy/X`'s own BUILT dist actually exports. Needs a prior `pnpm build`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSIONS = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" };
const PACKAGE_DIR: Record<string, string> = { "@wappy/core": "core", "@wappy/harness": "harness", "@wappy/whatsapp": "whatsapp", "@wappy/tools-openapi": "tools-openapi" };

const IMPORT_RE = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"(@wappy\/[a-z-]+)";?$/gm;

async function realExports(pkg: string): Promise<Set<string>> {
  const dir = PACKAGE_DIR[pkg];
  if (!dir) throw new Error(`unknown package in a generated import: "${pkg}"`);
  const mod: object = await import(pathToFileURL(resolve(repoRoot, "packages", dir, "dist", "index.js")).href);
  return new Set(Object.keys(mod));
}

function importedNames(content: string): { pkg: string; names: string[] }[] {
  const out: { pkg: string; names: string[] }[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const names = m[1]!.split(",").map((n) => n.replace(/^type\s+/, "").split(" as ")[0]!.trim()).filter(Boolean);
    out.push({ pkg: m[2]!, names });
  }
  return out;
}

const combos: { label: string; answers: RenderProjectOptions["answers"] }[] = [
  { label: "no store", answers: { model: DEFAULT_ANSWERS.model, tools: { kind: "none" } } },
  { label: "shopify, no skills", answers: { model: DEFAULT_ANSWERS.model, tools: { kind: "shopify" }, skills: { skills: [] } } },
  { label: "shopify, store-info", answers: { model: { provider: "anthropic" }, tools: { kind: "shopify" }, skills: { skills: ["store-info"] } } },
  { label: "shopify, orders", answers: { model: { provider: "gemini" }, tools: { kind: "shopify" }, skills: { skills: ["orders"] } } },
  { label: "shopify, products", answers: { model: { provider: "openai" }, tools: { kind: "shopify" }, skills: { skills: ["products"] } } },
  { label: "shopify, all three skills", answers: { model: { provider: "ollama" }, tools: { kind: "shopify" }, skills: { skills: ["store-info", "orders", "products"] } } },
];

describe.each(combos)("generated project imports are real, for combo: $label", ({ answers }) => {
  const files = renderProject({ answers, versions: VERSIONS });

  test("every named import from a @wappy/* package exists in that package's built exports", async () => {
    const cache = new Map<string, Set<string>>();
    for (const f of files) {
      for (const { pkg, names } of importedNames(f.content)) {
        if (!cache.has(pkg)) cache.set(pkg, await realExports(pkg));
        const exported = cache.get(pkg)!;
        const missing = names.filter((n) => !exported.has(n));
        expect(missing, `${f.path} imports {${missing.join(", ")}} from "${pkg}", which doesn't export them`).toEqual([]);
      }
    }
  });
});
