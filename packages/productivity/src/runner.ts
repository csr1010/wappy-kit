import type { Clock, Memory, MessageChannel, Model, SessionProfileStore } from "@wappy_ai/core";
import type { Task, TaskStore } from "./store.js";
import type { TemplateId } from "./templates.js";

/**
 * Everything an action gets alongside the task itself, beyond the plain "fetch data, format text"
 * needs of a reminder — defined here from Phase 2 onward (before any action actually uses it) so
 * the pluggable `actions` map never needs a breaking signature change once the memory-aware,
 * skill-backed Google actions land. The runner builds this; it never interprets `memory`/`model`
 * itself, matching this package's "generic engine, no domain knowledge" scope.
 */
export interface ActionContext {
  memory?: Memory;
  sessionProfileStore?: SessionProfileStore;
  model?: Model;
  /** The contact's other currently-active tasks (never includes the one currently running, never
   * an `'off'` one) — lets an action be self-aware of the rest of the person's schedule instead of
   * treating every task as if it exists in isolation. */
  siblingTasks: Task[];
}

export interface ActionResult {
  /** Whether the action itself ran without error — NOT whether the underlying capability is
   * connected. An honest stub ("Calendar isn't connected yet") is a successful call: `ok: true`.
   * `ok: false` is reserved for real failures (the API is down, a token refresh failed), which is
   * what actually triggers a retry — never fire a retry loop over an intentional, honest stub reply. */
  ok: boolean;
  message: string;
}

export type Action = (task: Task, ctx: ActionContext) => Promise<ActionResult>;

export interface RetryOptions {
  /** Total attempts per due run, including the first — not "N retries on top of" the first. Default 3. */
  maxAttempts?: number;
  /** Fixed delay between attempts. Default 2000ms. */
  delayMs?: number;
}

export interface CreateTaskRunnerOptions {
  store: TaskStore;
  channel: MessageChannel;
  actions: Partial<Record<TemplateId, Action>>;
  clock: Clock;
  memory?: Memory;
  sessionProfileStore?: SessionProfileStore;
  model?: Model;
  retry?: RetryOptions;
  /** How often `start()` drives `tick()`. Default 60000ms (60s). */
  intervalMs?: number;
}

export interface TaskRunner {
  /** Runs one due-task scan immediately — what `start()` drives on a timer, and what tests call
   * directly against an injected clock instead of waiting on a real interval. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_INTERVAL_MS = 60_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `dailyAt` compares against the clock's local hour/minute — no timezone handling beyond whatever
 * the Node process's own local time already is, a deliberate MVP scope limit (plan: no cron syntax,
 * no timezone complexity, until a real template needs it). A day only fires once: a task that
 * already ran today (by calendar day, from `lastRunAt`) doesn't fire again even if `tick()` runs
 * again within the same matching minute. */
function isDue(task: Task, nowMs: number): boolean {
  if (task.scheduleKind === "once") {
    const target = Date.parse(task.scheduleValue);
    return !Number.isNaN(target) && nowMs >= target;
  }
  const now = new Date(nowMs);
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (hhmm !== task.scheduleValue) return false;
  if (task.lastRunAt === undefined) return true;
  const last = new Date(task.lastRunAt);
  const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
  return !sameDay;
}

async function buildContext(task: Task, opts: CreateTaskRunnerOptions): Promise<ActionContext> {
  const allForContact = await opts.store.listByContact(task.contactId);
  const siblingTasks = allForContact.filter((t) => t.id !== task.id && t.status === "on");
  return { memory: opts.memory, sessionProfileStore: opts.sessionProfileStore, model: opts.model, siblingTasks };
}

/** Runs `action` up to `maxAttempts` times (a thrown error is treated the same as an `ok: false`
 * result — either way, retry), waiting `delayMs` between attempts, stopping the moment a result
 * comes back `ok: true`. Never sends anything itself — `tick()` decides what to do with the
 * final result, so a failing attempt never spams the contact with per-retry noise. */
async function runWithRetry(action: Action, task: Task, ctx: ActionContext, retry: RetryOptions | undefined, clock: Clock): Promise<ActionResult> {
  const maxAttempts = retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = retry?.delayMs ?? DEFAULT_DELAY_MS;
  let last: ActionResult = { ok: false, message: "no attempts made" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await action(task, ctx);
    } catch (e) {
      last = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (last.ok) return last;
    if (attempt < maxAttempts) await clock.sleep(delayMs);
  }
  return last;
}

/**
 * The generic task-running engine (Phase 2). Zero domain knowledge — it never knows what a "reminder"
 * or "Google" is, only that a due task has a `templateId` key into the injected `actions` map. A
 * future connector (e.g. `@wappy_ai/connector-google`) plugs into that map; it never changes this file.
 */
export function createTaskRunner(opts: CreateTaskRunnerOptions): TaskRunner {
  let timerHandle: number | undefined;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  async function tick(): Promise<void> {
    const now = opts.clock.now();
    const active = await opts.store.listActive();
    for (const task of active) {
      if (!isDue(task, now)) continue;
      const action = opts.actions[task.templateId];
      if (!action) continue; // no action registered for this template — nothing to run, not an error

      const ctx = await buildContext(task, opts);
      const result = await runWithRetry(action, task, ctx, opts.retry, opts.clock);

      if (result.ok) {
        const delivery = await opts.channel.send(task.contactId, { text: result.message });
        // "queued" is a real, ungated outcome — not a bug, not a reason to retry. It means: no
        // WhatsApp Message Template is configured (or none approved yet) AND the contact hasn't
        // messaged this bot in the last 24h, so Meta's platform rule leaves nothing to actually send
        // to. That's expected and fine for someone just trying this out — see WHATSAPP_SETUP.md §5,
        // an OPTIONAL step, not a prerequisite. What matters is never pretending it was delivered.
        if (delivery.status === "queued") {
          // eslint-disable-next-line no-console -- the one place a trial user (no template set up,
          // running locally) can actually see why a reminder didn't show up on their phone.
          console.warn(
            `[productivity] task "${task.title}" (${task.contactId}) ran fine but wasn't delivered: ${delivery.reason ?? "24h session window closed"}. ` +
              `Text the bot to reopen the window, or see WHATSAPP_SETUP.md §5 to set up a Message Template (optional).`,
          );
          await opts.store.update(task.id, { lastRunAt: now, lastStatus: "queued", retryCount: 0 }, now);
          // Deliberately does NOT flip a `once` task off — it never actually reached the contact, so
          // it stays `'on'` and gets another honest attempt at its next due check, instead of silently
          // disabling itself after a delivery that never happened.
        } else {
          await opts.store.update(task.id, { lastRunAt: now, lastStatus: "success", retryCount: 0 }, now);
          if (task.scheduleKind === "once") await opts.store.setStatus(task.id, "off", now);
        }
      } else {
        const delivery = await opts.channel.send(task.contactId, { text: `Your scheduled task "${task.title}" didn't run: ${result.message}` });
        // Best-effort: if even the failure notice comes back "queued", there's nothing more to do —
        // don't loop trying to announce a queued announcement.
        void delivery;
        await opts.store.update(task.id, { lastRunAt: now, lastStatus: "failed", retryCount: (opts.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - 1 }, now);
      }
    }
  }

  function scheduleNext(): void {
    timerHandle = opts.clock.setTimeout(() => {
      void tick().finally(scheduleNext);
    }, intervalMs);
  }

  return {
    tick,
    start() {
      if (timerHandle === undefined) scheduleNext();
    },
    stop() {
      if (timerHandle !== undefined) {
        opts.clock.clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    },
  };
}
