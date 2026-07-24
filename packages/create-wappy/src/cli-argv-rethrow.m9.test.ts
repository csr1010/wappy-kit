import { describe, expect, test, vi } from "vitest";

/** cli.ts's `catch (e) { if (e instanceof ArgvError) ...; throw e; }` around parseArgv is a
 * defensive rethrow for an error type parseArgv itself never actually produces today — covered
 * here by mocking argv.js to throw something else, proving genuinely unexpected errors still
 * propagate instead of being silently swallowed as if they were a user-facing flag error. */
vi.mock("./argv.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./argv.js")>();
  return {
    ...actual,
    parseArgv: () => {
      throw new Error("boom — not an ArgvError");
    },
  };
});

describe("runCli — an unexpected (non-ArgvError) parse failure propagates instead of being swallowed", () => {
  test("rethrows rather than reporting it as a normal flag error", async () => {
    const { runCli } = await import("./cli.js");
    await expect(
      runCli({ argv: [], cwd: "/tmp", versions: { core: "0", harness: "0", whatsapp: "0", toolsOpenapi: "0" }, runInteractive: async () => { throw new Error("unused"); }, print: () => {} }),
    ).rejects.toThrow("boom — not an ArgvError");
  });
});
