import { describe, expect, test } from "vitest";
import { readPartVersions } from "./versions.js";

// tools-openapi's own version resolution (with its optional-dependency fallback) was removed along
// with the "tools" step: @wappy_ai/create-agent no longer wires any tools/connector package, so
// there's nothing left to version-resolve for it — rewritten accordingly (`--allow-test-change`,
// SPEC.md decisions log).
//
// M14: harness bumped 0.0.0 -> 0.1.0 (a real first-publish version, found worth fixing while
// verifying a real npm install through a local registry — 0.0.0 was never meant to be the actual
// published version). Updated the hardcoded expectation below to match (`--allow-test-change`).
describe("readPartVersions", () => {
  test("reads each @wappy_ai/* part's real installed version via require.resolve, not a hardcoded value", () => {
    const versions = readPartVersions(import.meta.url);
    for (const v of Object.values(versions)) {
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Matches this monorepo's own packages' actual package.json "version" fields.
    expect(versions.core).toBe("0.1.0");
    expect(versions.harness).toBe("0.1.0");
  });
});
