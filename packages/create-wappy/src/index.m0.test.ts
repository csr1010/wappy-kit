import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("package boots", () => {
  expect(packageName).toBe("create-wappy");
});
