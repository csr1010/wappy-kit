#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDev } from "./dev.js";

/**
 * The `wappy` bin (distinct from the `create-agent` bin, `npm create @wappy/agent`) — what a generated project's
 * `"dev": "wappy dev"` script resolves to. §4.2 lists `status`/`reset`/`doctor`/`dev`; only `dev`
 * (T9.7) exists so far — the others print a clear "not yet" rather than silently doing nothing.
 */

const HELP_TEXT = `wappy — run a generated Wappy Kit project

Usage:
  wappy dev              boot the webhook server (+ tunnel) for this project

Not yet implemented: wappy status / wappy reset / wappy doctor.
`;

export async function main(argv: string[], cwd: string, print: (line: string) => void): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "dev") {
    const noTunnel = rest.includes("--no-tunnel");
    const portFlagIdx = rest.indexOf("--port");
    const port = portFlagIdx >= 0 ? Number(rest[portFlagIdx + 1]) : undefined;
    const result = await runDev({ cwd, print, tunnel: !noTunnel, port });
    if (result.exitCode !== 0) return result.exitCode;
    // main() returns normally here — the listening server (and open tunnel) are what keep the
    // process alive, same as any other long-running Node server; no need to block main() itself.
    process.on("SIGINT", () => {
      print("\nShutting down...");
      void result.close?.().then(() => process.exit(0));
    });
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    print(HELP_TEXT);
    return 0;
  }
  if (cmd === "status" || cmd === "reset" || cmd === "doctor") {
    print(`"wappy ${cmd}" isn't implemented yet.`);
    return 1;
  }
  print(`Unknown command "${cmd}".\n\n${HELP_TEXT}`);
  return 1;
}

export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.cwd(), (line) => console.log(line));
}
