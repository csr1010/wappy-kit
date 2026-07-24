import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Hub-and-spoke rules (SPEC §2). create-wappy / e2e / testkit are the "wiring" side and unrestricted here,
// except testkit must never leak into runtime deps of core or plugins.
const PLUGINS = ["harness", "whatsapp"];
const allowedFor = (pkg: string): string[] | null => (pkg === "core" ? [] : PLUGINS.includes(pkg) ? ["core"] : null);

const isTest = (f: string) => /\.test\.tsx?$/.test(f);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const f = join(dir, name);
    return statSync(f).isDirectory() ? sourceFiles(f) : /\.tsx?$/.test(name) ? [f] : [];
  });
}

const importsIn = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["'](@wappy\/[\w-]+)/g)].map((m) => m[1]!);

/** Returns human-readable violations for `<root>/packages/*`; empty array = clean. */
export function checkArchitecture(root: string): string[] {
  const out: string[] = [];
  const pkgsDir = join(root, "packages");
  for (const dir of readdirSync(pkgsDir)) {
    const allowed = allowedFor(dir);
    const manifest = join(pkgsDir, dir, "package.json");
    if (!allowed || !existsSync(manifest)) continue;
    const pj = JSON.parse(readFileSync(manifest, "utf8"));
    const bad = (target: string) => target.startsWith("@wappy/") && target !== `@wappy/${dir}` && !allowed.includes(target.slice(7));

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pj[field] ?? {})) if (bad(dep)) out.push(`${dir}: ${field} lists ${dep}`);
    }
    for (const dep of Object.keys(pj.devDependencies ?? {})) {
      if (bad(dep) && dep !== "@wappy/testkit") out.push(`${dir}: devDependencies lists ${dep}`);
    }
    for (const file of sourceFiles(join(pkgsDir, dir, "src"))) {
      for (const imp of importsIn(readFileSync(file, "utf8"))) {
        if (bad(imp) && !(isTest(file) && imp === "@wappy/testkit")) out.push(`${dir}: ${file.slice(root.length + 1)} imports ${imp}`);
      }
    }
  }
  return out;
}
