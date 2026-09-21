import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ci = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/ci.yml"), "utf8");

test("CI runs the cumulative gate, not just verify", () => {
  expect(ci).toMatch(/run:\s*pnpm gate \d+/);
});

test("CI covers Node 20, 22 and 24", () => {
  expect(ci).toMatch(/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/);
  expect(ci).toMatch(/node:\s*\[\s*20\s*,\s*22\s*,\s*24\s*\]/);
});

test("CI fetches full history and tags so the B2 baseline tag check can work", () => {
  expect(ci).toMatch(/fetch-depth:\s*0/);
});
