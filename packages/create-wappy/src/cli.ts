import { resolve } from "node:path";
import type { CompleteInterviewAnswers } from "./interview.js";
import { generateProject, StateLoadError } from "./generate.js";
import { resolveNonInteractiveAnswers } from "./non-interactive.js";
import { ArgvError, parseArgv, STEP_FLAG_KEYS, type ParsedArgv } from "./argv.js";
import type { PartVersions } from "./templates.js";

/**
 * `create-wappy`'s orchestration (T9.5's `create-wappy` command), kept independent of both
 * `@clack/prompts` and `process.*` so it's fully unit-testable without a TTY (per the milestone
 * brief's own "most of this milestone is testable without a TTY") — `bin.ts` wires the real
 * dependencies; tests inject fakes for `runInteractive`/`print`.
 *
 * Mode decision: any interview-step flag present (`STEP_FLAG_KEYS`) means non-interactive mode —
 * resolved via T9.2's `resolveNonInteractiveAnswers`, and a validation failure exits loud, NEVER
 * silently falls through to prompting (mixing "some flags, then ask interactively for the rest"
 * would make an already-wrong flag's error easy to miss in a scripted/CI invocation). Zero
 * interview-step flags means a plain `create-wappy` invocation — full interactive mode.
 */

const HELP_TEXT = `create-wappy — scaffold a WhatsApp agent

Usage:
  create-wappy                      interactive interview
  create-wappy --yes                interactive interview, but every omitted step takes its default
  create-wappy [flags]              non-interactive, e.g.:
    --model openai --framework none --skills store-info,orders \\
    --api shopify --shopify-store-domain my-shop.myshopify.com \\
    --memory local --router llm --whatsapp later

Flags:
  --model <openai|anthropic|gemini|ollama>
  --framework <none|mastra|vercel-ai-sdk|langgraph>
  --skills <comma-separated reference skill names, or "none">
  --api <none|shopify|<OpenAPI spec URL or file path>>
  --shopify-store-domain <domain>     (required with --api shopify)
  --memory <local|mem0|cognee|postgres>
  --router <llm|jev>
  --jev-key-path <path>                (required with --router jev)
  --whatsapp <now|later>
  --whatsapp-phone-number-id / --whatsapp-access-token / --whatsapp-verify-token  (required with --whatsapp now)
  --dir <path>                        target directory (default: current directory)
  --yes, -y                           accept defaults for any omitted step
  --help, -h                          show this help
`;

export interface CliDeps {
  argv: string[];
  cwd: string;
  versions: PartVersions;
  /** Runs the real @clack/prompts interview (interactive.ts) — injected so orchestration is
   * testable without a TTY. */
  runInteractive: () => Promise<CompleteInterviewAnswers>;
  print: (line: string) => void;
  projectName?: string;
}

export interface CliResult {
  exitCode: number;
}

function hasAnyStepFlag(parsed: ParsedArgv): boolean {
  return STEP_FLAG_KEYS.some((k) => parsed[k] !== undefined);
}

export async function runCli(deps: CliDeps): Promise<CliResult> {
  let parsed: ParsedArgv;
  try {
    parsed = parseArgv(deps.argv);
  } catch (e) {
    if (e instanceof ArgvError) {
      deps.print(`Error: ${e.message}`);
      return { exitCode: 1 };
    }
    throw e;
  }

  if (parsed.help) {
    deps.print(HELP_TEXT);
    return { exitCode: 0 };
  }

  let answers: CompleteInterviewAnswers;
  if (hasAnyStepFlag(parsed)) {
    const resolved = resolveNonInteractiveAnswers(parsed);
    if (!resolved.ok) {
      deps.print("Some flags were invalid or incomplete:");
      for (const e of resolved.errors) deps.print(`  - ${e}`);
      return { exitCode: 1 };
    }
    answers = resolved.answers;
  } else {
    try {
      answers = await deps.runInteractive();
    } catch (e) {
      deps.print(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: 1 };
    }
  }

  const projectRoot = parsed.dir ? resolve(deps.cwd, parsed.dir) : deps.cwd;
  try {
    const result = await generateProject({ answers, versions: deps.versions, projectRoot, projectName: deps.projectName });
    const written = result.results.filter((r) => !r.skipped).length;
    const skipped = result.results.filter((r) => r.skipped).length;
    deps.print(`\nDone — ${written} file(s) written${skipped > 0 ? `, ${skipped} already up to date` : ""} in ${projectRoot}.`);
    deps.print("See README.md for next steps.");
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof StateLoadError) {
      deps.print(`Error: ${e.message}`);
      return { exitCode: 1 };
    }
    throw e;
  }
}
