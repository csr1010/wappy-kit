import { describe, expect, test } from "vitest";
import { createSessionWindowTracker, SESSION_WINDOW_MS } from "./session-window.js";

describe("createSessionWindowTracker", () => {
  test("a contact never heard from has the window closed", () => {
    expect(createSessionWindowTracker().windowOpen("c1", 0)).toBe(false);
  });

  test("window is open just under 24h after the last inbound message", () => {
    const t = createSessionWindowTracker();
    t.recordInbound("c1", 0);
    expect(t.windowOpen("c1", SESSION_WINDOW_MS - 1)).toBe(true);
  });

  test("window is closed at exactly 24h and beyond", () => {
    const t = createSessionWindowTracker();
    t.recordInbound("c1", 0);
    expect(t.windowOpen("c1", SESSION_WINDOW_MS)).toBe(false);
    expect(t.windowOpen("c1", SESSION_WINDOW_MS + 60_000)).toBe(false);
  });

  test("a later inbound message resets the window", () => {
    const t = createSessionWindowTracker();
    t.recordInbound("c1", 0);
    t.recordInbound("c1", SESSION_WINDOW_MS - 100);
    expect(t.windowOpen("c1", SESSION_WINDOW_MS + 50)).toBe(true);
  });

  test("contacts are tracked independently", () => {
    const t = createSessionWindowTracker();
    t.recordInbound("c1", 0);
    expect(t.windowOpen("c2", 0)).toBe(false);
  });
});
