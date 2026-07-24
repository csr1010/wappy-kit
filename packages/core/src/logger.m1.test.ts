import { describe, expect, test } from "vitest";
import { noopLogger } from "./logger.js";

describe("noopLogger", () => {
  test("every level is callable and does nothing observable", () => {
    expect(() => noopLogger.debug("d", { a: 1 })).not.toThrow();
    expect(() => noopLogger.info("i")).not.toThrow();
    expect(() => noopLogger.warn("w")).not.toThrow();
    expect(() => noopLogger.error("e", { cause: "x" })).not.toThrow();
  });
});
