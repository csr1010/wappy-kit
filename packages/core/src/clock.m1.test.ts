import { describe, expect, test } from "vitest";
import { systemClock } from "./clock.js";

describe("systemClock", () => {
  test("now() advances with real time", () => {
    const t0 = systemClock.now();
    expect(t0).toBeGreaterThan(0);
    expect(systemClock.now()).toBeGreaterThanOrEqual(t0);
  });

  test("setTimeout fires and returns a handle clearTimeout can cancel", async () => {
    let fired = false;
    const handle = systemClock.setTimeout(() => {
      fired = true;
    }, 5);
    await systemClock.sleep(20);
    expect(fired).toBe(true);
    expect(typeof handle).toBe("number");
  });

  test("clearTimeout prevents the callback from firing", async () => {
    let fired = false;
    const handle = systemClock.setTimeout(() => {
      fired = true;
    }, 5);
    systemClock.clearTimeout(handle);
    await systemClock.sleep(20);
    expect(fired).toBe(false);
  });

  test("clearTimeout on an unknown handle is a no-op", () => {
    expect(() => systemClock.clearTimeout(999999)).not.toThrow();
  });

  test("sleep resolves after roughly the requested delay", async () => {
    const t0 = Date.now();
    await systemClock.sleep(10);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5);
  });
});
