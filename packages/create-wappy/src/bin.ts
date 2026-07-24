#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import { runInteractiveInterview } from "./interactive.js";
import { readPartVersions } from "./versions.js";

/** Wires the real dependencies for `runCli` — kept separate from the top-level execution below so
 * a test can import and call it with these three modules mocked, without triggering a real CLI run
 * as a side effect of the import itself. */
export async function main(): Promise<number> {
  const { exitCode } = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    versions: readPartVersions(),
    runInteractive: runInteractiveInterview,
    print: (line) => console.log(line),
  });
  return exitCode;
}

// npm/pnpm launch bins through a symlink (node_modules/.bin/create-wappy), so argv[1] is the link
// path, not this file — compare real paths or the installed CLI silently does nothing.
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Only run when this file is executed directly (the real npm bin entry) — not when a test imports it.
if (isDirectRun(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
