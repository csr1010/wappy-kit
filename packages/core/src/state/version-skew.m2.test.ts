import { describe, expect, test } from "vitest";
import { checkVersionSkew } from "./version-skew.js";

describe("checkVersionSkew", () => {
  test("no warnings when every part is satisfied by the running core version", () => {
    const warnings = checkVersionSkew("1.2.0", [
      { name: "whatsapp", coreVersionRange: "^1.0.0" },
      { name: "harness", coreVersionRange: "*" },
    ]);
    expect(warnings).toEqual([]);
  });

  test("warns for each part whose range the running core version fails", () => {
    const warnings = checkVersionSkew("2.0.0", [
      { name: "whatsapp", coreVersionRange: "^1.0.0" },
      { name: "harness", coreVersionRange: "^2.0.0" },
    ]);
    expect(warnings).toEqual([{ part: "whatsapp", message: "whatsapp requires core ^1.0.0, running 2.0.0" }]);
  });

  test("no parts -> no warnings", () => {
    expect(checkVersionSkew("1.0.0", [])).toEqual([]);
  });
});
