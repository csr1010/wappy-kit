import { describe, expect, test } from "vitest";
import { ArgvError, parseArgv, STEP_FLAG_KEYS } from "./argv.js";

describe("parseArgv", () => {
  test("parses the milestone brief's own example invocation", () => {
    const parsed = parseArgv(["--yes", "--model", "openai", "--api", "shopify"]);
    expect(parsed).toEqual({ yes: true, model: "openai", api: "shopify" });
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
    const parsed = parseArgv(["--model", "anthropic", "--api", "shopify", "--dir", "./my-bot"]);
    expect(parsed).toEqual({ model: "anthropic", api: "shopify", dir: "./my-bot" });
  });

  test("flags for steps that no longer exist are rejected, not silently ignored", () => {
    for (const gone of ["--framework", "--memory", "--router", "--whatsapp", "--shopify-store-domain", "--whatsapp-access-token", "--skills"]) {
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
    expect(() => parseArgv(["--model", "--api", "none"])).toThrow(ArgvError);
  });

  test("STEP_FLAG_KEYS lists exactly the 2 interview-step flags, excluding --dir/--yes/--help", () => {
    expect([...STEP_FLAG_KEYS].sort()).toEqual(["api", "model"]);
  });
});
