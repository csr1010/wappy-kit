import { describe, expect, test, vi } from "vitest";

/** Mirrors cli-argv-rethrow.m9.test.ts, for the other defensive rethrow: an unexpected
 * (non-StateLoadError) failure from generateProject must propagate, not be reported as if it were
 * an ordinary corrupt/too-new-state error. */
vi.mock("./generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./generate.js")>();
  return {
    ...actual,
    generateProject: () => {
      throw new Error("boom — not a StateLoadError");
    },
  };
});

describe("runCli — an unexpected (non-StateLoadError) generation failure propagates instead of being swallowed", () => {
  test("rethrows rather than reporting it as an ordinary state-load error", async () => {
    const { runCli } = await import("./cli.js");
    await expect(
      runCli({
        argv: ["--yes", "--model", "openai", "--api", "none"],
        cwd: "/tmp",
        versions: { core: "0", harness: "0", whatsapp: "0", toolsOpenapi: "0" },
        runInteractive: async () => {
          throw new Error("unused");
        },
        print: () => {},
      }),
    ).rejects.toThrow("boom — not a StateLoadError");
  });
});
