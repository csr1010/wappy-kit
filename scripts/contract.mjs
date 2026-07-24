#!/usr/bin/env node
// Contract snapshot (B3). Usage:
//   node scripts/contract.mjs check     fail if @wappy/core's public API drifted from contracts/core.api.json
//   node scripts/contract.mjs update    (re)write the snapshot from current source (pnpm contract:update)
// Extracts each named export of packages/core/src/index.ts (kind + printed type) via the
// TS compiler API, straight from source — no build step required first.
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "packages/core/src/index.ts");
const outFile = resolve(root, "contracts/core.api.json");

const PRINT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.MultilineObjectLiterals |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

function describeSymbol(checker, symbol) {
  const decl = symbol.declarations?.[0];
  const isTypeLevel = decl && (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl));
  const type = isTypeLevel
    ? checker.getDeclaredTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, decl ?? symbol.valueDeclaration ?? entry);
  return {
    kind: decl ? ts.SyntaxKind[decl.kind] : "Unknown",
    type: checker.typeToString(type, decl, PRINT_FLAGS),
  };
}

/** Public API of @wappy/core as { exportName: { kind, type } }, sorted by name. */
export function extractApi(entryFile = entry) {
  const program = ts.createProgram([entryFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryFile);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`contract.mjs: no module symbol for ${entryFile} (does it compile?)`);
  const api = {};
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    api[symbol.name] = describeSymbol(checker, symbol);
  }
  return Object.fromEntries(Object.entries(api).sort(([a], [b]) => a.localeCompare(b)));
}

/** Human-readable differences; empty = identical. Additions are reported too (must go through `update`). */
export function diffApi(baseline, current) {
  const diffs = [];
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) diffs.push(`removed: ${key}`);
    else if (JSON.stringify(baseline[key]) !== JSON.stringify(current[key])) diffs.push(`changed: ${key}`);
  }
  for (const key of Object.keys(current)) {
    if (!(key in baseline)) diffs.push(`added (run \`pnpm contract:update\`): ${key}`);
  }
  return diffs;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv[2];
  if (mode !== "check" && mode !== "update") {
    console.error("usage: contract.mjs check|update");
    process.exit(2);
  }
  let current;
  try {
    current = extractApi();
  } catch (e) {
    console.error(`contract.mjs: failed to extract API\n${String(e.stack ?? e)}`);
    process.exit(1);
  }
  if (mode === "update") {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(current, null, 2) + "\n");
    console.log(`contracts/core.api.json written: ${Object.keys(current).length} exports`);
  } else {
    if (!existsSync(outFile)) {
      console.error("no contracts/core.api.json — run `pnpm contract:update` first");
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(outFile, "utf8"));
    const diffs = diffApi(baseline, current);
    if (diffs.length) {
      console.error(`core API contract changed:\n  ${diffs.join("\n  ")}\nif intentional: pnpm contract:update, then add a Decisions Log line (docs/SPEC.md §16).`);
      process.exit(1);
    }
    console.log(`core API contract ok: ${Object.keys(current).length} exports`);
  }
}
