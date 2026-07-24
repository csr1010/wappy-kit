import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the published shape, not the workspace. Workspace tests can't catch a tarball that
// omits dist/ files (npm falls back to .gitignore, which ignores dist, when `files` is unset),
// which crashed the installed `create-wappy` bin on startup. Needs a prior `pnpm build`
// (the gate builds before running tests).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const publishable = ["core", "harness", "whatsapp", "create-wappy"];

function packedFiles(pkg: string): string[] {
  const dir = resolve(repoRoot, "packages", pkg);
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
  return (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path);
}

describe.each(publishable)("packed tarball: %s", (pkg) => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages", pkg, "package.json"), "utf8"));
  const files = packedFiles(pkg);

  test("ships every built entry: main, types, and bin targets", () => {
    const wanted = [manifest.main, manifest.types, ...Object.values<string>(manifest.bin ?? {})].filter(Boolean);
    for (const w of wanted) expect(files).toContain(w.replace(/^\.\//, ""));
  });

  test("ships all of dist (a bin importing a sibling file must not break)", () => {
    const dist = resolve(repoRoot, "packages", pkg, "dist");
    const built = execFileSync("find", [dist, "-name", "*.js", "-not", "-name", "*.test.js"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((p) => "dist/" + p.slice(dist.length + 1));
    for (const b of built) expect(files).toContain(b);
  });

  test("does not ship sources, tests, or tsconfig", () => {
    expect(files.filter((f) => /^src\//.test(f) || /\.test\./.test(f) || f === "tsconfig.json")).toEqual([]);
  });
});
