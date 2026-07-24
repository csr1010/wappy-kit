#!/usr/bin/env node
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

// Only run when this file is executed directly (the real npm bin entry) — not when a test imports it.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
