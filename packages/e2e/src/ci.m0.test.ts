import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ci = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/ci.yml"), "utf8");

test("CI runs the cumulative gate, not just verify", () => {
  expect(ci).toMatch(/run:\s*pnpm gate \d+/);
});

// --allow-test-change: dropped Node 20 from the matrix — the `ai` package (Vercel AI SDK,
// createVercelModel's real dependency, pulled into every generated project) declares
// "engines": {"node": ">=22"} in its own package.json, confirmed directly, not assumed. Testing
// against an unsupported Node version was never a real guarantee.
test("CI covers Node 22 and 24, not an unsupported 20", () => {
  expect(ci).toMatch(/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/);
  expect(ci).toMatch(/node:\s*\[\s*22\s*,\s*24\s*\]/);
});

test("CI fetches full history and tags so the B2 baseline tag check can work", () => {
  expect(ci).toMatch(/fetch-depth:\s*0/);
});
