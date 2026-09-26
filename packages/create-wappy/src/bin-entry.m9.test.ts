import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDirectRun } from "./bin.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "wappy-bin-"));
  dirs.push(d);
  const real = join(d, "bin.js");
  writeFileSync(real, "");
  return { d, real, url: pathToFileURL(real).href };
}

describe("isDirectRun — entry-point guard for the npm bin", () => {
  test("true when argv[1] is the file itself", () => {
    const s = scratch();
    expect(isDirectRun(s.real, s.url)).toBe(true);
  });

  test("true when argv[1] is a symlink to the file (how npm/pnpm launch bins)", () => {
    const s = scratch();
    const link = join(s.d, "create-agent");
    symlinkSync(s.real, link);
    expect(isDirectRun(link, s.url)).toBe(true);
  });

  test("false when argv[1] is a different file (module imported by another script/test)", () => {
    const s = scratch();
    const other = join(s.d, "other.js");
    writeFileSync(other, "");
    expect(isDirectRun(other, s.url)).toBe(false);
  });

  test("false when there is no argv[1] (e.g. `node -e`)", () => {
    expect(isDirectRun(undefined, "file:///whatever.js")).toBe(false);
  });

  test("false, not a throw, when argv[1] can't be resolved on disk", () => {
    const s = scratch();
    expect(isDirectRun(join(s.d, "does-not-exist.js"), s.url)).toBe(false);
  });
});
