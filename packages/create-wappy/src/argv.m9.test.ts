import { describe, expect, test } from "vitest";
import { ArgvError, parseArgv, STEP_FLAG_KEYS } from "./argv.js";

// --api (the "tools" step, M9, Shopify) was removed entirely — domain connectors are out of scope
// for this open-source repo now. Rewritten accordingly (`--allow-test-change`, SPEC.md decisions log).
describe("parseArgv", () => {
  test("parses the milestone brief's own example invocation", () => {
    const parsed = parseArgv(["--yes", "--model", "openai"]);
    expect(parsed).toEqual({ yes: true, model: "openai" });
  });

  test("--yes and -y both set the yes flag; --help and -h both set help", () => {
    expect(parseArgv(["--yes"]).yes).toBe(true);
    expect(parseArgv(["-y"]).yes).toBe(true);
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv(["-h"]).help).toBe(true);
  });

  test("an empty argv list parses to an empty object", () => {
    expect(parseArgv([])).toEqual({});
  });

  test("parses every documented flag, including --dir", () => {
    const parsed = parseArgv(["--model", "anthropic", "--dir", "./my-bot"]);
    expect(parsed).toEqual({ model: "anthropic", dir: "./my-bot" });
  });

  // --allow-test-change (M15, "Memory backend — local vs. Cognee"): --memory removed from this list
  // — it's a real flag again (a different, unrelated choice than whatever the original pre-M9
  // "memory storage" step asked; this one picks the Knowledge/RAG backend) — see its own coverage
  // in `resolveNonInteractiveAnswers`'s tests instead.
  test("flags for steps that no longer exist are rejected, not silently ignored", () => {
    for (const gone of ["--framework", "--router", "--whatsapp", "--shopify-store-domain", "--whatsapp-access-token", "--skills", "--api"]) {
      expect(() => parseArgv([gone, "x"])).toThrow(/Unrecognized flag/);
    }
  });

  test("an unrecognized flag throws ArgvError", () => {
    expect(() => parseArgv(["--nope", "x"])).toThrow(ArgvError);
    expect(() => parseArgv(["--nope", "x"])).toThrow(/Unrecognized flag/);
  });

  test("a flag missing its value throws ArgvError", () => {
    expect(() => parseArgv(["--model"])).toThrow(ArgvError);
    expect(() => parseArgv(["--model"])).toThrow(/requires a value/);
  });

  test("a flag immediately followed by another flag (no value) throws ArgvError", () => {
    expect(() => parseArgv(["--model", "--dir"])).toThrow(ArgvError);
  });

  // productivity (--productivity, @wappy_ai/productivity) added as a second interview-step flag
  // later; memory (--memory, M15) added as a third — updated to match, excluding
  // --dir/--yes/--help (`--allow-test-change`, SPEC.md decisions log).
  test("STEP_FLAG_KEYS lists exactly the 3 interview-step flags, excluding --dir/--yes/--help", () => {
    expect([...STEP_FLAG_KEYS]).toEqual(["model", "memory", "productivity"]);
  });

  test("--memory is a real, recognized flag again (the Knowledge/RAG backend choice)", () => {
    expect(parseArgv(["--memory", "cognee"])).toEqual({ memory: "cognee" });
  });
});
