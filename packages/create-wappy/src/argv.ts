import type { NonInteractiveFlags } from "./non-interactive.js";

/**
 * Pure argv -> flags parsing (T9.2/T9.5) — no process.argv read here, so it's testable with plain
 * arrays. Long-form flags only (`--model openai`, not `-m openai`) except `--yes`/`-y` and
 * `--help`/`-h`, matching the milestone brief's own example invocation.
 */
export interface ParsedArgv extends NonInteractiveFlags {
  /** Project directory to generate into — relative to cwd, resolved by the caller. Default: cwd. */
  dir?: string;
  help?: boolean;
}

const FLAG_KEYS: Record<string, keyof ParsedArgv> = {
  "--model": "model",
  "--framework": "framework",
  "--skills": "skills",
  "--api": "api",
  "--shopify-store-domain": "shopifyStoreDomain",
  "--memory": "memory",
  "--router": "router",
  "--jev-key-path": "jevKeyPath",
  "--whatsapp": "whatsapp",
  "--whatsapp-phone-number-id": "whatsappPhoneNumberId",
  "--whatsapp-access-token": "whatsappAccessToken",
  "--whatsapp-verify-token": "whatsappVerifyToken",
  "--dir": "dir",
};

/** The set of flags `hasAnyStepFlag` (cli.ts) checks to decide interactive vs. non-interactive —
 * deliberately excludes `--dir` (a target-directory choice, not an interview answer). */
export const STEP_FLAG_KEYS: (keyof ParsedArgv)[] = ["model", "framework", "skills", "api", "memory", "router", "whatsapp"];

export class ArgvError extends Error {}

export function parseArgv(argv: string[]): ParsedArgv {
  const result: ParsedArgv = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    const key = FLAG_KEYS[arg];
    if (!key) throw new ArgvError(`Unrecognized flag: "${arg}".`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ArgvError(`"${arg}" requires a value.`);
    (result as Record<string, string>)[key] = value;
    i++;
  }
  return result;
}
