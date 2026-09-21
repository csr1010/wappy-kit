import { afterEach, describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, tmpProject } from "@wappy/testkit";
import { checkArchitecture } from "./arch.js";

afterEach(() => cleanupAllTmpProjects());

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture(pkgs: Record<string, { deps?: string[]; dev?: string[]; src?: string }>) {
  const p = tmpProject();
  for (const [name, def] of Object.entries(pkgs)) {
    const dependencies = Object.fromEntries((def.deps ?? []).map((d) => [d, "workspace:*"]));
    const devDependencies = Object.fromEntries((def.dev ?? []).map((d) => [d, "workspace:*"]));
    p.write(`packages/${name}/package.json`, JSON.stringify({ name: `@wappy/${name}`, dependencies, devDependencies }));
    if (def.src !== undefined) p.write(`packages/${name}/src/index.ts`, def.src);
  }
  return p.dir;
}

describe("architecture guard (B9)", () => {
  test("the real repo has no violations", () => {
    expect(checkArchitecture(repoRoot)).toEqual([]);
  });

  test("core -> plugin dependency is flagged", () => {
    const dir = fixture({ core: { deps: ["@wappy/harness"] }, harness: {} });
    expect(checkArchitecture(dir).join("\n")).toMatch(/core.*@wappy\/harness/);
  });

  test("core -> plugin source import is flagged", () => {
    const dir = fixture({ core: { src: 'import x from "@wappy/whatsapp";' }, whatsapp: {} });
    expect(checkArchitecture(dir).join("\n")).toMatch(/core.*@wappy\/whatsapp/);
  });

  test("plugin <-> plugin is flagged, plugin -> core is fine", () => {
    const ok = fixture({ core: {}, harness: { deps: ["@wappy/core"], src: 'import "@wappy/core";' } });
    expect(checkArchitecture(ok)).toEqual([]);
    const bad = fixture({ core: {}, harness: { deps: ["@wappy/core"] }, whatsapp: { src: 'export * from "@wappy/harness";' } });
    expect(checkArchitecture(bad).join("\n")).toMatch(/whatsapp.*@wappy\/harness/);
  });

  test("testkit is allowed only as a devDependency", () => {
    expect(checkArchitecture(fixture({ core: {}, harness: { dev: ["@wappy/testkit"] } }))).toEqual([]);
    expect(checkArchitecture(fixture({ core: {}, harness: { deps: ["@wappy/testkit"] } })).join("\n")).toMatch(/harness.*@wappy\/testkit/);
  });

  test("the CLI may depend on anything", () => {
    const dir = fixture({ core: {}, harness: {}, "create-wappy": { deps: ["@wappy/core", "@wappy/harness"] } });
    expect(checkArchitecture(dir)).toEqual([]);
  });
});
