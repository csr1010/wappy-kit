import { describe, expect, test } from "vitest";
import { ArgvError, parseArgv, STEP_FLAG_KEYS } from "./argv.js";

describe("parseArgv", () => {
  test("parses the milestone brief's own example invocation", () => {
    const parsed = parseArgv(["--yes", "--model", "openai", "--memory", "local", "--router", "llm", "--api", "shopify", "--whatsapp", "later"]);
    expect(parsed).toEqual({ yes: true, model: "openai", memory: "local", router: "llm", api: "shopify", whatsapp: "later" });
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

  test("parses every documented flag, including --dir and the sub-flags", () => {
    const parsed = parseArgv([
      "--framework",
      "none",
      "--skills",
      "store-info,orders",
      "--shopify-store-domain",
      "my-shop.myshopify.com",
      "--jev-key-path",
      "/keys/jev.json",
      "--whatsapp-phone-number-id",
      "123",
      "--whatsapp-access-token",
      "tok",
      "--whatsapp-verify-token",
      "verify",
      "--dir",
      "./my-bot",
    ]);
    expect(parsed).toEqual({
      framework: "none",
      skills: "store-info,orders",
      shopifyStoreDomain: "my-shop.myshopify.com",
      jevKeyPath: "/keys/jev.json",
      whatsappPhoneNumberId: "123",
      whatsappAccessToken: "tok",
      whatsappVerifyToken: "verify",
      dir: "./my-bot",
    });
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
    expect(() => parseArgv(["--model", "--memory", "local"])).toThrow(ArgvError);
  });

  test("STEP_FLAG_KEYS lists exactly the 7 interview-step flags, excluding --dir/--yes/--help", () => {
    expect(STEP_FLAG_KEYS.sort()).toEqual(["api", "framework", "memory", "model", "router", "skills", "whatsapp"].sort());
  });
});
