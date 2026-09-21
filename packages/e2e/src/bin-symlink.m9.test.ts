import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAllTmpProjects, tmpProject } from "@wappy/testkit";

afterEach(() => cleanupAllTmpProjects());

// npm/pnpm launch a package bin through a symlink (node_modules/.bin/create-wappy), so
// process.argv[1] is the symlink path, not the real file. A naive `import.meta.url === argv[1]`
// entry guard then silently does nothing — the installed CLI would exit 0 with no output.
// Needs a prior build (the gate builds before running tests).
const distBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../create-wappy/dist/bin.js");

test.skipIf(!existsSync(distBin))("bin runs when launched through a symlink, like npm's .bin", () => {
  const proj = tmpProject();
  const link = proj.path("create-wappy");
  symlinkSync(distBin, link);
  const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
  expect(out).toContain("Usage:");
});
