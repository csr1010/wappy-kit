#!/usr/bin/env node
// Cumulative milestone gate. Usage:
//   pnpm gate <n>                      full gate: lint, typecheck, build, tests m0..mn, B2/B3/B8 checks
//   pnpm gate <n> --quick              typecheck, build, tests for m<n> only (inner-loop)
//   pnpm gate <n> --allow-test-change "reason"   permit edits to older tests/fixtures (logged)
// Output is deliberately terse: one line per step, tail of output only on failure.
import { spawnSync } from "node:child_process";
import { existsSync, appendFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const n = Number(argv[0]);
if (!Number.isInteger(n) || n < 0 || n > 11) {
  console.error('usage: pnpm gate <0-11> [--quick] [--allow-test-change "reason"]');
  process.exit(2);
}
const quick = argv.includes("--quick");
const allowIdx = argv.indexOf("--allow-test-change");
const allowReason = allowIdx >= 0 ? argv[allowIdx + 1] : undefined;
if (allowIdx >= 0 && !allowReason) {
  console.error("--allow-test-change needs a reason string");
  process.exit(2);
}

const TAIL = 60;
let failed = 0;

function sh(cmd, args, cwd = root) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function tail(text) {
  return text.split("\n").slice(-TAIL).join("\n");
}
function step(name, fn) {
  const t0 = Date.now();
  let res;
  try {
    res = fn();
  } catch (e) {
    res = { ok: false, out: String(e?.stack ?? e) };
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.skip) {
    console.log(`- ${name}  (skipped: ${res.skip})`);
    return;
  }
  if (res.ok) {
    console.log(`✓ ${name}  (${secs}s)`);
  } else {
    failed++;
    console.log(`✗ ${name}  (${secs}s)`);
    if (res.out) console.log(tail(res.out).replace(/^/gm, "    "));
  }
}
const run = (cmd, args) => () => {
  const r = sh(cmd, args);
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// --- test-file inventory (tracked + untracked, minus ignored) ---------------------------
const listed = sh("git", ["ls-files", "-co", "--exclude-standard", "--", "*.test.ts"]).stdout
  .split("\n")
  .filter(Boolean);
const tagOf = (f) => {
  const t = /\.m(\d+)\.test\.ts$/.exec(f);
  return t ? Number(t[1]) : null;
};

console.log(`gate M${n}${quick ? " (quick)" : ""}\n`);

// 0. Milestone mechanisms that must exist (backward-testing layers, see docs/MILESTONES.md)
step("required mechanisms exist", () => {
  const need = [
    "scripts/gate.mjs",
    "scripts/ctx.mjs",
    "packages/testkit/package.json",
    "packages/e2e/package.json",
    "scripts/ratchet.mjs",
  ];
  if (n >= 1) need.push("scripts/contract.mjs", "contracts/core.api.json");
  const missing = need.filter((p) => !existsSync(resolve(root, p)));
  if (!listed.some((f) => /(^|\/)arch\.m0\.test\.ts$/.test(f))) missing.push("arch.m0.test.ts (B9)");
  if (n >= 5 && !listed.some((f) => /spine-a\.m5\.test\.ts$/.test(f))) missing.push("spine-a.m5.test.ts (B5)");
  if (n >= 8) {
    for (const s of ["b", "c"]) {
      if (!listed.some((f) => new RegExp(`spine-${s}\\.m8\\.test\\.ts$`).test(f))) missing.push(`spine-${s}.m8.test.ts (B5)`);
    }
  }
  if (n >= 9 && !existsSync(resolve(root, "fixtures/generated"))) missing.push("fixtures/generated (B7)");
  return { ok: missing.length === 0, out: missing.length ? `missing:\n  ${missing.join("\n  ")}` : "" };
});

// 1. Tag discipline (B1 relies on it)
step("tests are milestone-tagged", () => {
  const untagged = listed.filter((f) => tagOf(f) === null);
  const problems = untagged.map((f) => `untagged (rename to *.m<N>.test.ts): ${f}`);
  if (n > 0 && !listed.some((f) => tagOf(f) === n)) problems.push(`no tests tagged m${n} — a milestone must add tests`);
  return { ok: problems.length === 0, out: problems.join("\n") };
});

// 2. Static checks
if (!quick) step("lint", run("pnpm", ["run", "lint"]));
step("typecheck", run("pnpm", ["exec", "turbo", "run", "typecheck", "--output-logs=errors-only"]));
if (!quick) step("build", run("pnpm", ["exec", "turbo", "run", "build", "--output-logs=errors-only"]));
if (quick) step("build (needed by tests)", run("pnpm", ["exec", "turbo", "run", "build", "--output-logs=errors-only"]));

// 3. B1 cumulative suites (quick = only this milestone's tests)
{
  const from = quick ? n : 0;
  const filters = [];
  for (let i = from; i <= n; i++) filters.push(`.m${i}.test`);
  // Loop packages ourselves: avoids depending on pnpm's recursive-run flag semantics.
  const pkgs = readdirSync(resolve(root, "packages")).filter((d) => existsSync(resolve(root, "packages", d, "package.json")));
  step(`tests ${quick ? `m${n}` : `m0..m${n}`} (B1)`, () => {
    let out = "";
    let ok = true;
    for (const d of pkgs) {
      const r = sh("pnpm", ["exec", "vitest", "run", "--passWithNoTests", ...filters], resolve(root, "packages", d));
      if (r.status !== 0) {
        ok = false;
        out += `--- packages/${d}\n${r.stdout ?? ""}${r.stderr ?? ""}\n`;
      }
    }
    return { ok, out };
  });
}

// 4. B2 immutability vs previous milestone tag
if (n >= 1 && !quick) {
  step("old tests/fixtures unchanged (B2)", () => {
    const base = `m${n - 1}-done`;
    if (sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${base}`]).status !== 0) {
      return { skip: `no baseline tag ${base} yet` };
    }
    const d = sh("git", ["diff", "--name-status", base, "--", "*.test.ts", "fixtures/"]).stdout
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.startsWith("A")); // additions are always fine
    if (d.length === 0) return { ok: true };
    if (allowReason) {
      appendFileSync(resolve(root, "docs/PROGRESS.md"), `\n- ${new Date().toISOString().slice(0, 10)}: gate M${n} --allow-test-change: ${allowReason}\n  ${d.join("\n  ")}\n`);
      return { ok: true, out: "" };
    }
    return { ok: false, out: `changed/removed since ${base} (fix the code, not the test; or pass --allow-test-change "<reason>"):\n${d.join("\n")}` };
  });
}

// 5. B3 contract snapshot, B8 coverage ratchet
if (n >= 1 && !quick && existsSync(resolve(root, "scripts/contract.mjs"))) step("core contract snapshot (B3)", run("node", ["scripts/contract.mjs", "check"]));
if (!quick && existsSync(resolve(root, "scripts/ratchet.mjs"))) step("coverage ratchet (B8)", run("node", ["scripts/ratchet.mjs", "check"]));

console.log(failed === 0 ? `\nGATE M${n}: PASS${n >= 0 ? `  → git tag m${n}-done` : ""}` : `\nGATE M${n}: FAIL (${failed} step${failed > 1 ? "s" : ""})`);
process.exit(failed === 0 ? 0 : 1);
