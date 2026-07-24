import { afterEach, expect, test } from "vitest";
import { cleanupAllTmpProjects } from "@wappy/testkit";
import { createSpine } from "./harness.js";

afterEach(() => cleanupAllTmpProjects());

// Placeholder: proves e2e is wired into turbo and can boot the (still empty) spine.
test("empty spine boots and tears down cleanly", async () => {
  const spine = await createSpine();
  expect(spine.whatsapp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(spine.project.dir).toBeTruthy();
  await spine.close();
});
