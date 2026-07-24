import { beforeAll, describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";

const runDevMock = vi.fn(async () => ({ exitCode: 0, close: vi.fn(async () => {}) }));
vi.mock("./dev.js", () => ({ runDev: runDevMock }));

let main: (typeof import("./wappy-bin.js"))["main"];
beforeAll(async () => {
  ({ main } = await import("./wappy-bin.js"));
});

describe("wappy-bin's main() — dispatch, not the real dev server", () => {
  test("no subcommand (or --help/-h) prints help, exit 0", async () => {
    for (const argv of [[], ["--help"], ["-h"]]) {
      const print = vi.fn();
      const code = await main(argv, "/tmp", print);
      expect(code).toBe(0);
      expect(print).toHaveBeenCalledWith(expect.stringContaining("wappy dev"));
    }
  });

  test("an unknown command prints an error + help, exit 1", async () => {
    const print = vi.fn();
    const code = await main(["bogus"], "/tmp", print);
    expect(code).toBe(1);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('Unknown command "bogus"'));
  });

  test.each(["status", "reset", "doctor"])("%s is a clear not-yet-implemented, exit 1 — not a silent no-op", async (cmd) => {
    const print = vi.fn();
    const code = await main([cmd], "/tmp", print);
    expect(code).toBe(1);
    expect(print).toHaveBeenCalledWith(expect.stringContaining("isn't implemented yet"));
  });

  test("dev passes cwd/print through to runDev, with tunnel true by default", async () => {
    runDevMock.mockClear();
    const print = vi.fn();
    const code = await main(["dev"], "/proj", print);
    expect(code).toBe(0);
    expect(runDevMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/proj", tunnel: true, port: undefined }));
  });

  test("dev --no-tunnel passes tunnel: false", async () => {
    runDevMock.mockClear();
    await main(["dev", "--no-tunnel"], "/proj", () => {});
    expect(runDevMock).toHaveBeenCalledWith(expect.objectContaining({ tunnel: false }));
  });

  test("dev --port 4000 is parsed and passed through", async () => {
    runDevMock.mockClear();
    await main(["dev", "--port", "4000"], "/proj", () => {});
    expect(runDevMock).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }));
  });

  test("dev exits with runDev's own non-zero code without hanging (a preflight failure)", async () => {
    runDevMock.mockClear();
    runDevMock.mockResolvedValueOnce({ exitCode: 1 });
    const code = await main(["dev"], "/proj", () => {});
    expect(code).toBe(1);
  });

  test("SIGINT after a successful dev start calls close() and exits cleanly", async () => {
    const close = vi.fn(async () => {});
    runDevMock.mockClear();
    runDevMock.mockResolvedValueOnce({ exitCode: 0, close });
    const print = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await main(["dev"], "/proj", print);
    process.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(print).toHaveBeenCalledWith(expect.stringContaining("Shutting down"));

    exitSpy.mockRestore();
    process.removeAllListeners("SIGINT");
  });
});

describe("wappy-bin.ts executed directly (the real npm entry)", () => {
  test("when argv[1] is this very module, importing it runs main() and sets the exit code", async () => {
    const realArgv1 = process.argv[1];
    const realExitCode = process.exitCode;
    runDevMock.mockClear();
    process.argv[1] = fileURLToPath(new URL("./wappy-bin.ts", import.meta.url));
    try {
      vi.resetModules();
      await import("./wappy-bin.js");
      // No subcommand -> help text, exit 0 — proves the top-level isDirectRun guard actually ran
      // main() as a side effect of the import, not just that the module loaded.
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv[1] = realArgv1!;
      process.exitCode = realExitCode;
    }
  });
});
