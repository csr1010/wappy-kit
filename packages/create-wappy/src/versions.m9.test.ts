import { describe, expect, test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPartVersions } from "./versions.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("readPartVersions", () => {
  test("reads each @wappy/* part's real installed version via require.resolve, not a hardcoded value", () => {
    const versions = readPartVersions(import.meta.url);
    for (const v of Object.values(versions)) {
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Matches this monorepo's own packages' actual package.json "version" fields.
    expect(versions.core).toBe("0.1.0");
    expect(versions.harness).toBe("0.0.0");
  });

  // Regression/npm-decoupling: create-wappy no longer depends on @wappy/tools-openapi at all
  // (Shopify's own dependency tree must never be pulled in just by installing create-wappy — only
  // a GENERATED PROJECT that actually picks Shopify depends on it, in its own separate
  // package.json). require.resolve genuinely can't find it from this package in this monorepo any
  // more (verified: `packages/create-wappy/node_modules/@wappy/` has no tools-openapi symlink) —
  // so this exercises the real fallback path, not a mocked one.
  test("@wappy/tools-openapi isn't installed alongside create-wappy, and readPartVersions still returns a usable version (the release-pinned fallback)", () => {
    const versions = readPartVersions(import.meta.url);
    expect(versions.toolsOpenapi).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The fallback exists specifically for create-wappy's own (normal) case — but the optional-read
  // path also has a SUCCESS branch when @wappy/tools-openapi genuinely IS resolvable (e.g. a
  // consumer that installs it alongside create-wappy anyway). Exercised here via a fromUrl inside
  // @wappy/e2e, a sibling package that still depends on it for its own testing needs.
  test("when @wappy/tools-openapi IS resolvable from the caller's context, its real version is used, not the fallback", () => {
    const fromUrl = pathToFileURL(resolve(repoRoot, "packages/e2e/dummy.js")).href;
    const versions = readPartVersions(fromUrl);
    expect(versions.toolsOpenapi).toBe("0.0.0"); // real installed version, matches packages/tools-openapi/package.json
  });
});
