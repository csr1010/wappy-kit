#!/usr/bin/env node
// Prints one milestone brief + ONLY the spec sections it cites, so a session
// never has to load the whole spec. Usage: pnpm ctx M3
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (process.argv[2] ?? "").toUpperCase();
const m = /^M(\d+)$/.exec(arg);
if (!m) {
  console.error("usage: pnpm ctx M<n>   (e.g. pnpm ctx M3)");
  process.exit(2);
}

const briefPath = resolve(root, `docs/milestones/${arg}.md`);
if (!existsSync(briefPath)) {
  console.error(`no brief at docs/milestones/${arg}.md`);
  process.exit(2);
}
const brief = readFileSync(briefPath, "utf8");
const spec = readFileSync(resolve(root, "docs/SPEC.md"), "utf8").split("\n");

// Only the "**Spec:** ..." line decides which sections get printed.
const specLine = brief.split("\n").find((l) => l.startsWith("**Spec:**")) ?? "";
const refs = [...specLine.split("·")[0].matchAll(/§(\d+(?:\.\d+)?)/g)].map((x) => x[1]);

// Section = from its heading up to the next heading of the same or higher level.
function section(ref) {
  const [major, minor] = ref.split(".");
  const wantSub = minor !== undefined;
  const headRe = wantSub
    ? new RegExp(`^### ${major}\\.${minor}\\b`)
    : new RegExp(`^## ${major}\\.\\s`);
  const start = spec.findIndex((l) => headRe.test(l));
  if (start === -1) return wantSub ? section(major) : null; // e.g. §15.1 is a list item -> whole §15
  const level = spec[start].startsWith("###") ? 3 : 2;
  let end = spec.length;
  for (let i = start + 1; i < spec.length; i++) {
    const h = /^(#{2,3}) /.exec(spec[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return { key: spec[start], text: spec.slice(start, end).join("\n").trimEnd() };
}

const printed = new Set();
const parts = [];
for (const ref of refs) {
  const s = section(ref);
  if (!s || printed.has(s.key)) continue;
  printed.add(s.key);
  parts.push(s.text);
}

console.log(`# ===== BRIEF: ${arg} =====\n`);
console.log(brief.trimEnd());
console.log(`\n# ===== SPEC SECTIONS (${[...printed].length}) =====\n`);
console.log(parts.join("\n\n"));
console.log(`\n# ===== next: docs/PROGRESS.md for handoff, then work one task at a time =====`);
