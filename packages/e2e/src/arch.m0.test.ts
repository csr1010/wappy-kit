import { afterEach, describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, tmpProject } from "@wappy_ai/testkit";
import { checkArchitecture } from "./arch.js";

afterEach(() => cleanupAllTmpProjects());

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture(pkgs: Record<string, { deps?: string[]; dev?: string[]; src?: string }>) {
  const p = tmpProject();
  for (const [name, def] of Object.entries(pkgs)) {
    const dependencies = Object.fromEntries((def.deps ?? []).map((d) => [d, "workspace:*"]));
    const devDependencies = Object.fromEntries((def.dev ?? []).map((d) => [d, "workspace:*"]));
    p.write(`packages/${name}/package.json`, JSON.stringify({ name: `@wappy_ai/${name}`, dependencies, devDependencies }));
    if (def.src !== undefined) p.write(`packages/${name}/src/index.ts`, def.src);
  }
  return p.dir;
}

describe("architecture guard (B9)", () => {
  test("the real repo has no violations", () => {
    expect(checkArchitecture(repoRoot)).toEqual([]);
  });

  test("core -> plugin dependency is flagged", () => {
    const dir = fixture({ core: { deps: ["@wappy_ai/harness"] }, harness: {} });
    expect(checkArchitecture(dir).join("\n")).toMatch(/core.*@wappy_ai\/harness/);
  });

  test("core -> plugin source import is flagged", () => {
    const dir = fixture({ core: { src: 'import x from "@wappy_ai/whatsapp";' }, whatsapp: {} });
    expect(checkArchitecture(dir).join("\n")).toMatch(/core.*@wappy_ai\/whatsapp/);
  });

  test("plugin <-> plugin is flagged, plugin -> core is fine", () => {
    const ok = fixture({ core: {}, harness: { deps: ["@wappy_ai/core"], src: 'import "@wappy_ai/core";' } });
    expect(checkArchitecture(ok)).toEqual([]);
    const bad = fixture({ core: {}, harness: { deps: ["@wappy_ai/core"] }, whatsapp: { src: 'export * from "@wappy_ai/harness";' } });
    expect(checkArchitecture(bad).join("\n")).toMatch(/whatsapp.*@wappy_ai\/harness/);
  });

  test("testkit is allowed only as a devDependency", () => {
    expect(checkArchitecture(fixture({ core: {}, harness: { dev: ["@wappy_ai/testkit"] } }))).toEqual([]);
    expect(checkArchitecture(fixture({ core: {}, harness: { deps: ["@wappy_ai/testkit"] } })).join("\n")).toMatch(/harness.*@wappy_ai\/testkit/);
  });

  test("the CLI may depend on anything", () => {
    const dir = fixture({ core: {}, harness: {}, "create-wappy": { deps: ["@wappy_ai/core", "@wappy_ai/harness"] } });
    expect(checkArchitecture(dir)).toEqual([]);
  });
});
