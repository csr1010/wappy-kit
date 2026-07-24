import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain .mjs script, no types (test files are excluded from tsc anyway)
import { diffApi, extractApi } from "../../../scripts/contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("contract snapshot (B3)", () => {
  test("extractApi(core) matches the committed contracts/core.api.json baseline", () => {
    const current = extractApi();
    const baseline = JSON.parse(readFileSync(resolve(repoRoot, "contracts/core.api.json"), "utf8"));
    expect(diffApi(baseline, current)).toEqual([]);
  });

  test("extracted API includes the core public surface", () => {
    const current = extractApi();
    for (const name of ["Agent", "Router", "Tool", "ToolProvider", "MessageChannel", "Memory", "Skill", "Model", "PluginRegistry", "Tracer", "SmartMessageSchema"]) {
      expect(current).toHaveProperty(name);
    }
  });

  test("diffApi: identical snapshots -> no diffs", () => {
    const snap = { Foo: { kind: "InterfaceDeclaration", type: "{ a: string }" } };
    expect(diffApi(snap, { ...snap })).toEqual([]);
  });

  test("diffApi: a planted removal is caught", () => {
    const baseline = {
      PluginRegistry: { kind: "ClassDeclaration", type: "typeof PluginRegistry" },
      Tracer: { kind: "InterfaceDeclaration", type: "Tracer" },
    };
    const current = { Tracer: baseline.Tracer };
    expect(diffApi(baseline, current)).toEqual(["removed: PluginRegistry"]);
  });

  test("diffApi: a changed signature is caught", () => {
    const baseline = { Foo: { kind: "InterfaceDeclaration", type: "{ a: string }" } };
    const current = { Foo: { kind: "InterfaceDeclaration", type: "{ a: number }" } };
    expect(diffApi(baseline, current)).toEqual(["changed: Foo"]);
  });

  test("diffApi: a new export is flagged as an addition, not silently accepted", () => {
    const baseline = { Foo: { kind: "InterfaceDeclaration", type: "{ a: string }" } };
    const current = { ...baseline, Bar: { kind: "InterfaceDeclaration", type: "{ b: string }" } };
    expect(diffApi(baseline, current)).toEqual(["added (run `pnpm contract:update`): Bar"]);
  });
});
