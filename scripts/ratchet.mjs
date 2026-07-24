#!/usr/bin/env node
// Coverage ratchet (B8). Usage:
//   node scripts/ratchet.mjs check     fail if any aggregate coverage metric dropped below coverage-baseline.json
//   node scripts/ratchet.mjs update    raise the baseline (never lowers it; pass --force to lower deliberately)
// Coverage is aggregated across packages (sum covered / sum total) so adding a package can't hide a drop elsewhere.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = ["lines", "statements", "functions", "branches"];
const TOLERANCE = 0.01; // percentage points; absorbs float noise, not real drops

/** summaries: array of vitest json-summary objects ({total: {lines: {covered,total}, ...}}) */
export function aggregate(summaries) {
  const out = {};
  for (const m of METRICS) {
    let covered = 0;
    let total = 0;
    for (const s of summaries) {
      covered += s.total?.[m]?.covered ?? 0;
      total += s.total?.[m]?.total ?? 0;
    }
    out[m] = total === 0 ? 100 : (covered / total) * 100;
  }
  return out;
}

/** Returns a list of human-readable regressions (empty = ok). */
export function compare(baseline, current) {
  return METRICS.filter((m) => current[m] < (baseline[m] ?? 0) - TOLERANCE).map(
    (m) => `${m}: ${current[m].toFixed(2)}% < baseline ${baseline[m].toFixed(2)}%`,
  );
}

function measure(root) {
  const pkgsDir = resolve(root, "packages");
  const summaries = [];
  for (const d of readdirSync(pkgsDir)) {
    const cwd = resolve(pkgsDir, d);
    if (!existsSync(resolve(cwd, "package.json"))) continue;
    const r = spawnSync(
      "pnpm",
      [
        "exec", "vitest", "run", "--passWithNoTests",
        "--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=json-summary",
        "--coverage.include=src/**/*.ts", "--coverage.exclude=**/*.test.ts",
        "--coverage.reportsDirectory=coverage",
      ],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(`tests failed while measuring coverage in packages/${d}\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-3000));
    const f = resolve(cwd, "coverage/coverage-summary.json");
    if (existsSync(f)) summaries.push(JSON.parse(readFileSync(f, "utf8")));
  }
  return aggregate(summaries);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baselineFile = resolve(root, "coverage-baseline.json");
  const mode = process.argv[2];
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
  if (mode !== "check" && mode !== "update") {
    console.error("usage: ratchet.mjs check|update [--force]");
    process.exit(2);
  }
  let current;
  try {
    current = measure(root);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
  const fmt = (o) => METRICS.map((m) => `${m} ${o[m].toFixed(2)}%`).join(", ");
  if (mode === "check") {
    if (!baseline) {
      console.error("no coverage-baseline.json — run `pnpm ratchet` first");
      process.exit(1);
    }
    const bad = compare(baseline, current);
    if (bad.length) {
      console.error(`coverage dropped:\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`coverage ok: ${fmt(current)}`);
  } else {
    const force = process.argv.includes("--force");
    const next = Object.fromEntries(METRICS.map((m) => [m, force || !baseline ? current[m] : Math.max(current[m], baseline[m] ?? 0)]));
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
    console.log(`baseline: ${fmt(next)}`);
  }
}
