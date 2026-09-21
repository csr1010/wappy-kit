import { describe, expect, test, vi } from "vitest";

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
});
