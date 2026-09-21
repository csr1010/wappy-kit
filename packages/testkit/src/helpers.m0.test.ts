import { describe, expect, test, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpProject, cleanupAllTmpProjects, fakeClock, signWebhook } from "./index.js";

afterEach(() => cleanupAllTmpProjects());

describe("tmpProject", () => {
  test("creates a dir, isolates HOME, cleans up and restores HOME", () => {
    const realHome = process.env.HOME;
    const p = tmpProject();
    expect(existsSync(p.dir)).toBe(true);
    expect(process.env.HOME).toBe(p.home);
    expect(p.home).not.toBe(realHome);
    p.write("a/b.txt", "hi");
    expect(readFileSync(p.path("a/b.txt"), "utf8")).toBe("hi");
    p.cleanup();
    expect(existsSync(p.dir)).toBe(false);
    expect(process.env.HOME).toBe(realHome);
  });
  test("cleanupAll removes projects that were never cleaned", () => {
    const p = tmpProject();
    cleanupAllTmpProjects();
    expect(existsSync(p.dir)).toBe(false);
  });
});

describe("fakeClock", () => {
  test("advance fires timers in order, deterministically", () => {
    const c = fakeClock(1000);
    const seen: string[] = [];
    c.setTimeout(() => seen.push("b"), 200);
    c.setTimeout(() => seen.push("a"), 100);
    expect(c.now()).toBe(1000);
    c.advance(150);
    expect(seen).toEqual(["a"]);
    expect(c.now()).toBe(1150);
    c.advance(100);
    expect(seen).toEqual(["a", "b"]);
  });
  test("clear prevents firing; sleep resolves on advance", async () => {
    const c = fakeClock(0);
    let fired = false;
    const h = c.setTimeout(() => (fired = true), 10);
    c.clearTimeout(h);
    let slept = false;
    const s = c.sleep(50).then(() => (slept = true));
    c.advance(100);
    await s;
    expect(fired).toBe(false);
    expect(slept).toBe(true);
  });
});

describe("signWebhook", () => {
  test("produces sha256=<hmac hex> over the exact body", () => {
    const body = '{"x":1}';
    const expected = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(signWebhook(body, "s3cret")).toBe(expected);
    expect(signWebhook(body, "other")).not.toBe(expected);
  });
});
