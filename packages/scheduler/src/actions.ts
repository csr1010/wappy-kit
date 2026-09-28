import type { Action } from "./runner.js";
import type { TemplateId } from "./templates.js";

/**
 * Phase 3: real actions for `reminder`/`wake_me_up` — zero external accounts, no LLM, just format
 * and let the runner send it. Honest stubs for the 3 Google-backed templates, replaced for real by
 * `@wappy_ai/connector-google`'s actions later (Phase 6) — merged into this same map, never a change
 * to this file. A stub is a successful call (`ok: true`): it isn't an error, so it never triggers a
 * retry, matching `ActionResult.ok`'s documented meaning.
 */

const NOT_CONNECTED = "That needs Google connected first — open your task list and tap \"Connect Google\" to enable this.";

export const reminderAction: Action = async (task) => {
  const text = task.placeholders.text ?? "your reminder";
  return { ok: true, message: `⏰ Reminder: ${text}` };
};

export const wakeMeUpAction: Action = async () => {
  return { ok: true, message: "☀️ Good morning! Time to wake up." };
};

const dailyMeetingsStub: Action = async () => ({ ok: true, message: NOT_CONNECTED });
const summarizeEmailsStub: Action = async () => ({ ok: true, message: NOT_CONNECTED });
const findEmailsStub: Action = async () => ({ ok: true, message: NOT_CONNECTED });

/** Ready to hand straight to `createTaskRunner({actions: DEFAULT_ACTIONS})` — every template has an
 * entry from day one, real or stub, so `create-agent` (Phase 5) never has to know which 2 of the 5
 * happen to be real yet. Phase 6 merges its own actions object over this one to upgrade the 3 stubs. */
export const DEFAULT_ACTIONS: Record<TemplateId, Action> = {
  reminder: reminderAction,
  wake_me_up: wakeMeUpAction,
  daily_meetings: dailyMeetingsStub,
  summarize_emails: summarizeEmailsStub,
  find_emails: findEmailsStub,
};
