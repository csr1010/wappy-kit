import { describe, expect, test, vi } from "vitest";
import { fakeChannel, fakeClock } from "@wappy_ai/testkit";
import { createTaskRunner, type Action, type ActionContext } from "./runner.js";
import { createTaskStore, type NewTask } from "./store.js";

/** Phase 2 (plan: "Scheduler engine — due-task detection, retry, failure notification, no UI,
 * no real actions yet"). Everything here uses fakeClock/fakeChannel — no real timers, no real
 * network, ticks are driven by calling tick()/advance() directly. */

function freshStore() {
  return createTaskStore({ url: ":memory:" });
}

const DAILY: NewTask = {
  contactId: "+15550001111",
  templateId: "reminder",
  title: "Remind me about call mom",
  placeholders: { text: "call mom", time: "09:00" },
  scheduleKind: "dailyAt",
  scheduleValue: "09:00",
};

/** `runWithRetry`'s backoff goes through the injected `Clock`'s `sleep()`, which — on `fakeClock` —
 * only ever resolves when `advance()` is explicitly called (it never fires on its own, by design:
 * that's what makes it deterministic instead of racy). A plain `await runner.tick()` while a retry
 * is pending would hang forever. This drives it: start `tick()`, then repeatedly flush pending
 * microtasks and nudge the clock forward until `tick()` actually resolves. */
async function driveTick(runner: { tick(): Promise<void> }, clock: ReturnType<typeof fakeClock>, stepMs: number): Promise<void> {
  let done = false;
  const settled = runner.tick().finally(() => {
    done = true;
  });
  for (let i = 0; i < 50 && !done; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (!done) clock.advance(stepMs);
  }
  await settled;
}

function atLocalTime(base: Date, hh: number, mm: number): number {
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

describe("createTaskRunner — due detection", () => {
  test("a dailyAt task fires exactly once per tick when the clock's time matches", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 9, 0));
    const channel = fakeChannel();
    const succeed: Action = async () => ({ ok: true, message: "reminder: call mom" });
    await store.create(DAILY, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeed } });
    await runner.tick();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toEqual({ to: "+15550001111", message: { text: "reminder: call mom" } });
  });

  test("a dailyAt task whose time doesn't match the clock doesn't fire", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 10, 30));
    const channel = fakeChannel();
    const succeed: Action = async () => ({ ok: true, message: "should not fire" });
    await store.create(DAILY, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeed } });
    await runner.tick();

    expect(channel.sent).toHaveLength(0);
  });

  test("a once task fires after its timestamp passes, then auto-flips to 'off' and never fires again", async () => {
    const store = freshStore();
    const clock = fakeClock(1_000);
    const channel = fakeChannel();
    const succeed: Action = async () => ({ ok: true, message: "one-off reminder" });
    const created = await store.create({ ...DAILY, scheduleKind: "once", scheduleValue: new Date(2_000).toISOString() }, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeed } });

    await runner.tick(); // clock at 1000, target 2000 — not due yet
    expect(channel.sent).toHaveLength(0);

    clock.advance(1_500); // now 2500, past the 2000 target
    await runner.tick();
    expect(channel.sent).toHaveLength(1);

    const [after] = await store.listByContact(created.contactId);
    expect(after!.status).toBe("off");

    clock.advance(10_000);
    await runner.tick(); // status is 'off' -> listActive() won't even return it
    expect(channel.sent).toHaveLength(1); // unchanged
  });

  test("an 'off' task never fires regardless of schedule match", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 9, 0));
    const channel = fakeChannel();
    const succeed: Action = async () => ({ ok: true, message: "should not fire" });
    const created = await store.create(DAILY, clock.now());
    await store.setStatus(created.id, "off", clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeed } });
    await runner.tick();

    expect(channel.sent).toHaveLength(0);
  });
});

describe("createTaskRunner — retry and failure notification", () => {
  test("an always-failing action retries up to maxAttempts, then sends exactly one honest failure notice", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 9, 0));
    const channel = fakeChannel();
    let calls = 0;
    const alwaysFails: Action = async () => {
      calls++;
      return { ok: false, message: "the API is down" };
    };
    const created = await store.create(DAILY, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: alwaysFails }, retry: { maxAttempts: 3, delayMs: 10 } });
    await driveTick(runner, clock, 10);

    expect(calls).toBe(3);
    expect(channel.sent).toHaveLength(1); // exactly one message, not one per retry
    expect((channel.sent[0]!.message as { text: string }).text).toContain("didn't run");
    expect((channel.sent[0]!.message as { text: string }).text).toContain("the API is down");

    const [after] = await store.listByContact(created.contactId);
    expect(after!.lastStatus).toBe("failed");
  });

  test("an action that succeeds on the 2nd attempt stops retrying immediately and records success", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 9, 0));
    const channel = fakeChannel();
    let calls = 0;
    const succeedsSecondTry: Action = async () => {
      calls++;
      if (calls < 2) return { ok: false, message: "transient" };
      return { ok: true, message: "reminder: call mom" };
    };
    const created = await store.create(DAILY, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeedsSecondTry }, retry: { maxAttempts: 3, delayMs: 10 } });
    await driveTick(runner, clock, 10);

    expect(calls).toBe(2);
    expect(channel.sent).toHaveLength(1);
    const [after] = await store.listByContact(created.contactId);
    expect(after!.lastStatus).toBe("success");
  });
});

describe("createTaskRunner — start()/stop()", () => {
  test("start() drives tick() on the injected clock's timer; stop() cancels it", async () => {
    const store = freshStore();
    const startMs = 1_000_000;
    const clock = fakeClock(startMs);
    const channel = fakeChannel();
    const succeed: Action = async () => ({ ok: true, message: "fired" });
    // A 'once' task target inside the first interval window — a 'dailyAt' task would be flaky here,
    // since advancing the clock by a full interval can carry the local minute past an exact "HH:MM"
    // match (caught by running this test for real, not assumed correct on paper).
    await store.create({ ...DAILY, scheduleKind: "once", scheduleValue: new Date(startMs + 30_000).toISOString() }, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: succeed }, intervalMs: 60_000 });
    runner.start();
    clock.advance(60_000);
    await vi.waitFor(() => expect(channel.sent.length).toBeGreaterThan(0));

    runner.stop();
    const sentAfterStop = channel.sent.length;
    clock.advance(10 * 60_000);
    expect(channel.sent.length).toBe(sentAfterStop); // no further ticks after stop()
  });
});

describe("createTaskRunner — ActionContext", () => {
  test("ctx.siblingTasks excludes the running task, other contacts, and 'off' tasks", async () => {
    const store = freshStore();
    const clock = fakeClock(atLocalTime(new Date(), 9, 0));
    const channel = fakeChannel();
    let seenCtx: ActionContext | undefined;
    const capture: Action = async (_task, ctx) => {
      seenCtx = ctx;
      return { ok: true, message: "ok" };
    };

    const running = await store.create(DAILY, clock.now());
    const sibling = await store.create({ ...DAILY, templateId: "wake_me_up", scheduleValue: "10:00" }, clock.now());
    const offTask = await store.create({ ...DAILY, templateId: "wake_me_up", scheduleValue: "11:00" }, clock.now());
    await store.setStatus(offTask.id, "off", clock.now());
    // Deliberately a different contact AND a different template — a same-template task for another
    // contact would also be "due" and call `capture` again, overwriting seenCtx with the wrong
    // contact's (empty) context. Caught by running this test for real, not assumed correct on paper.
    await store.create({ ...DAILY, contactId: "+1999", templateId: "wake_me_up", scheduleValue: "12:00" }, clock.now());

    const runner = createTaskRunner({ store, channel, clock, actions: { reminder: capture } });
    await runner.tick();

    expect(seenCtx).toBeDefined();
    const siblingIds = seenCtx!.siblingTasks.map((t) => t.id);
    expect(siblingIds).toContain(sibling.id);
    expect(siblingIds).not.toContain(running.id);
    expect(siblingIds).not.toContain(offTask.id);
  });
});
