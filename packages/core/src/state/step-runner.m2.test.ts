import { describe, expect, test, vi } from "vitest";
import { createEmptyState } from "./schema.js";
import { runStep, runSteps, type StepDef } from "./step-runner.js";

describe("runStep", () => {
  test("a fresh step runs and is recorded done", async () => {
    const spy = vi.fn();
    const { state, result } = await runStep(createEmptyState("r1"), { id: "a", part: "p", run: spy }, { now: () => 10 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "a", status: "done", skipped: false });
    expect(state.steps).toEqual([{ id: "a", part: "p", status: "done" }]);
    expect(state.lastStep).toBe("a");
    expect(state.updatedAt).toBe(10);
  });

  test("a step already done is skipped, run() is not called again", async () => {
    const spy = vi.fn();
    const seeded = { ...createEmptyState("r1"), steps: [{ id: "a", part: "p", status: "done" as const }] };
    const { result } = await runStep(seeded, { id: "a", part: "p", run: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "a", status: "done", skipped: true });
  });

  test("a throwing step is recorded failed with the error message, not re-thrown", async () => {
    const { state, result } = await runStep(createEmptyState("r1"), {
      id: "a",
      part: "p",
      run: () => {
        throw new Error("boom");
      },
    });
    expect(result).toEqual({ id: "a", status: "failed", error: "boom", skipped: false });
    expect(state.steps).toEqual([{ id: "a", part: "p", status: "failed", error: "boom" }]);
  });

  test("a step that throws a non-Error value still records a string error", async () => {
    const { result } = await runStep(createEmptyState("r1"), {
      id: "a",
      part: "p",
      run: () => {
        throw "raw string failure";
      },
    });
    expect(result).toEqual({ id: "a", status: "failed", error: "raw string failure", skipped: false });
  });

  test("a previously-failed step is retried (not skipped)", async () => {
    const spy = vi.fn();
    const seeded = { ...createEmptyState("r1"), steps: [{ id: "a", part: "p", status: "failed" as const, error: "old" }] };
    const { state, result } = await runStep(seeded, { id: "a", part: "p", run: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("done");
    expect(state.steps).toEqual([{ id: "a", part: "p", status: "done" }]);
  });
});

describe("runSteps: resume from first incomplete", () => {
  test("stops after the first failure; steps < k are not re-executed on the next call", async () => {
    const calls: string[] = [];
    let bShouldFail = true;
    const defs: StepDef[] = [
      {
        id: "a",
        part: "p",
        run: () => {
          calls.push("a");
        },
      },
      {
        id: "b",
        part: "p",
        run: () => {
          calls.push("b");
          if (bShouldFail) throw new Error("b failed");
        },
      },
      {
        id: "c",
        part: "p",
        run: () => {
          calls.push("c");
        },
      },
    ];

    const first = await runSteps(createEmptyState("r1"), defs);
    expect(calls).toEqual(["a", "b"]);
    expect(first.results.map((r) => r.status)).toEqual(["done", "failed"]);
    expect(first.state.steps.map((s) => s.id)).toEqual(["a", "b"]);

    // Resume: rerun the whole def list against the resulting state — "a" must not run again.
    calls.length = 0;
    bShouldFail = false;
    const second = await runSteps(first.state, defs);
    expect(calls).toEqual(["b", "c"]); // a skipped; b retried since it failed; c now runs
    expect(second.results.map((r) => `${r.id}:${r.status}`)).toEqual(["a:done", "b:done", "c:done"]);
  });

  test("all steps succeed in order", async () => {
    const calls: string[] = [];
    const defs: StepDef[] = [
      {
        id: "a",
        part: "p",
        run: () => {
          calls.push("a");
        },
      },
      {
        id: "b",
        part: "p",
        run: () => {
          calls.push("b");
        },
      },
    ];
    const { results } = await runSteps(createEmptyState("r1"), defs);
    expect(calls).toEqual(["a", "b"]);
    expect(results.every((r) => r.status === "done")).toBe(true);
  });
});
