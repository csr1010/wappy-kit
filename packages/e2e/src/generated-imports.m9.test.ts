import { describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_ANSWERS, renderProject, type RenderProjectOptions } from "@wappy_ai/create-agent";

/**
 * Found by hand-testing the real installed CLI against a real registry (Verdaccio) instead of the
 * workspace: `renderProject()` generated `import { createInMemoryTracer } from "@wappy_ai/harness"`,
 * but that function actually lives in `@wappy_ai/core` — a generated project crashed on the very first
 * `import` with "does not provide an export named 'createInMemoryTracer'". No workspace test caught
 * it, because none of them load the generated code as a real module against the real built
 * packages; every unit test only does string-matching (`toContain(...)`) on the rendered source.
 *
 * This test closes that class of bug generically: for every combination `renderProject` can emit,
 * every `import { a, b, ... } from "@wappy_ai/X"` in the generated `index.ts` names only symbols
 * `@wappy_ai/X`'s own BUILT dist actually exports. Needs a prior `pnpm build`. (M12 removed the
 * `skills/*.ts` files this used to also scan; the "tools" step/`tools/*.ts` files this used to also
 * scan were removed entirely afterward — `@wappy_ai/tools-openapi` no longer ships from this repo.)
 *
 * A "productivity" interview step was added later (@wappy_ai/productivity, then
 * @wappy_ai/connector-google for the real Google wiring): `VERSIONS`/`PACKAGE_DIR` updated to
 * include both, and the combo matrix now covers productivity true/false, not just model providers —
 * otherwise this test would silently stop checking the newest import surface it exists to catch bugs
 * in (`--allow-test-change`, SPEC.md decisions log).
 *
 * M15 ("Memory backend — local vs. Cognee") added a `memory` interview step
 * (@wappy_ai/connector-cognee for the Cognee-backed wiring) — same reasoning, same update:
 * `VERSIONS`/`PACKAGE_DIR` now include `connector-cognee`, and the combo matrix covers
 * memory:local/cognee too (`--allow-test-change`, same decisions log).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSIONS = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", productivity: "0.1.0", connectorGoogle: "0.1.0", connectorCognee: "0.1.0", createWappy: "0.1.0" };
const PACKAGE_DIR: Record<string, string> = {
  "@wappy_ai/core": "core",
  "@wappy_ai/harness": "harness",
  "@wappy_ai/whatsapp": "whatsapp",
  "@wappy_ai/productivity": "productivity",
  "@wappy_ai/connector-google": "connector-google",
  "@wappy_ai/connector-cognee": "connector-cognee",
};

const IMPORT_RE = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"(@wappy_ai\/[a-z-]+)";?$/gm;

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
  { label: "openai (default), local memory, productivity off", answers: { model: DEFAULT_ANSWERS.model, memory: DEFAULT_ANSWERS.memory, productivity: { enabled: false } } },
  { label: "anthropic, local memory, productivity off", answers: { model: { provider: "anthropic" }, memory: DEFAULT_ANSWERS.memory, productivity: { enabled: false } } },
  { label: "ollama, local memory, productivity off", answers: { model: { provider: "ollama" }, memory: DEFAULT_ANSWERS.memory, productivity: { enabled: false } } },
  { label: "openai, local memory, productivity ON", answers: { model: DEFAULT_ANSWERS.model, memory: DEFAULT_ANSWERS.memory, productivity: { enabled: true } } },
  { label: "openai, cognee memory, productivity off", answers: { model: DEFAULT_ANSWERS.model, memory: { backend: "cognee" }, productivity: { enabled: false } } },
  { label: "openai, cognee memory, productivity ON", answers: { model: DEFAULT_ANSWERS.model, memory: { backend: "cognee" }, productivity: { enabled: true } } },
];

describe.each(combos)("generated project imports are real, for combo: $label", ({ answers }) => {
  const files = renderProject({ answers, versions: VERSIONS });

  test("every named import from a @wappy_ai/* package exists in that package's built exports", async () => {
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
