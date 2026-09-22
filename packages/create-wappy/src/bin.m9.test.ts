import { describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";

const runCliMock = vi.fn(async () => ({ exitCode: 0 }));
const runInteractiveMock = vi.fn(async () => ({}));
const readPartVersionsMock = vi.fn(() => ({ core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" }));

vi.mock("./cli.js", () => ({ runCli: runCliMock }));
vi.mock("./interactive.js", () => ({ runInteractiveInterview: runInteractiveMock }));
vi.mock("./versions.js", () => ({ readPartVersions: readPartVersionsMock }));

describe("bin.ts's main() — wires real argv/cwd/versions/interactive into runCli", () => {
  test("passes process.argv (minus the node/script args), process.cwd(), and the real version lookup through to runCli", async () => {
    const { main } = await import("./bin.js");
    const exitCode = await main();
    expect(exitCode).toBe(0);
    expect(runCliMock).toHaveBeenCalledTimes(1);
    const call = runCliMock.mock.calls[0]![0];
    expect(call.argv).toEqual(process.argv.slice(2));
    expect(call.cwd).toBe(process.cwd());
    expect(call.versions).toEqual({ core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", toolsOpenapi: "0.1.0" });
    expect(call.runInteractive).toBe(runInteractiveMock);
  });

  test("returns runCli's own exit code", async () => {
    runCliMock.mockResolvedValueOnce({ exitCode: 1 });
    const { main } = await import("./bin.js");
    expect(await main()).toBe(1);
  });

  test("the print callback it hands runCli writes to stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runCliMock.mockClear();
    const { main } = await import("./bin.js");
    await main();
    runCliMock.mock.calls[0]![0].print("hello from the CLI");
    expect(log).toHaveBeenCalledWith("hello from the CLI");
    log.mockRestore();
  });
});

describe("bin.ts executed directly (the real npm entry) runs main() and sets the exit code", () => {
  test("when argv[1] is this very module, importing it runs the CLI", async () => {
    const realArgv1 = process.argv[1];
    const realExit = process.exitCode;
    runCliMock.mockClear();
    runCliMock.mockResolvedValueOnce({ exitCode: 3 });
    process.argv[1] = fileURLToPath(new URL("./bin.ts", import.meta.url));
    try {
      vi.resetModules();
      await import("./bin.js");
      expect(runCliMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(3);
    } finally {
      process.argv[1] = realArgv1!;
      process.exitCode = realExit;
    }
  });
});
