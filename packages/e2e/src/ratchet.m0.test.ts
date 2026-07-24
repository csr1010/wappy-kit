import { describe, expect, test } from "vitest";
// @ts-expect-error plain .mjs script, no types (test files are excluded from tsc anyway)
import { aggregate, compare } from "../../../scripts/ratchet.mjs";

const pkg = (covered: number, total: number) => ({
  total: Object.fromEntries(["lines", "statements", "functions", "branches"].map((k) => [k, { covered, total }])),
});

describe("coverage ratchet (B8)", () => {
  test("aggregate sums covered/total across packages, ignoring empty ones", () => {
    const r = aggregate([pkg(5, 10), pkg(15, 20), pkg(0, 0)]);
    expect(r.lines).toBeCloseTo(66.67, 1); // 20/30
    expect(Object.keys(r).sort()).toEqual(["branches", "functions", "lines", "statements"]);
  });

  test("no packages with code yields 100 (nothing to regress)", () => {
    expect(aggregate([pkg(0, 0)]).lines).toBe(100);
  });

  test("compare passes on equal or better, fails on a drop", () => {
    const base = { lines: 80, statements: 80, functions: 80, branches: 80 };
    expect(compare(base, base)).toEqual([]);
    expect(compare(base, { ...base, lines: 95 })).toEqual([]);
    const bad = compare(base, { ...base, branches: 70 });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/branches/);
  });

  test("tiny float noise is tolerated", () => {
    const base = { lines: 80, statements: 80, functions: 80, branches: 80 };
    expect(compare(base, { ...base, lines: 79.999 })).toEqual([]);
  });
});
