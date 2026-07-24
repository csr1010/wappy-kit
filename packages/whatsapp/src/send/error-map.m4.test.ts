import { describe, expect, test } from "vitest";
import { mapMetaErrorCode } from "./error-map.js";

describe("mapMetaErrorCode", () => {
  test.each([
    [130429, 429, "retry"],
    [131026, 400, "fallback"],
    [131047, 400, "template"],
    [131051, 400, "fallback"],
    [131056, 400, "retry"],
    [133010, 400, "alert"],
    [190, 401, "alert"],
    [368, 403, "alert"],
    [100, 400, "drop"],
  ] as const)("known code %s -> %s", (code, httpStatus, expected) => {
    expect(mapMetaErrorCode(code, httpStatus)).toBe(expected);
  });

  test("an unknown code falls back to the HTTP status: 429 -> retry", () => {
    expect(mapMetaErrorCode(999999, 429)).toBe("retry");
  });

  test("an unknown code falls back to the HTTP status: 5xx -> retry", () => {
    expect(mapMetaErrorCode(999999, 503)).toBe("retry");
  });

  test("an unknown code falls back to the HTTP status: other 4xx -> fallback", () => {
    expect(mapMetaErrorCode(999999, 403)).toBe("fallback");
  });

  test("no code at all (e.g. non-JSON body) uses the HTTP status alone", () => {
    expect(mapMetaErrorCode(undefined, 502)).toBe("retry");
    expect(mapMetaErrorCode(undefined, 404)).toBe("fallback");
  });

  test("an entirely unexpected 2xx/3xx status defaults to retry (should not normally be called for a success)", () => {
    expect(mapMetaErrorCode(undefined, 200)).toBe("retry");
  });
});
