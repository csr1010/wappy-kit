import { z } from "zod";
import type { InboundMessage, Model } from "@wappy_ai/core";
import { buildInstructions, templateById } from "./templates.js";
import type { Task, TaskStore } from "./store.js";

/**
 * v2 redesign's core piece, replacing the old cron-driven `runner.ts`: tasks are reactive, not
 * scheduled. When an inbound message arrives, this matches it against the contact's saved tasks and,
 * on a confident match, runs that template's fixed instructions against fresh connector data. Every
 * reply is a direct response to an inbound message, so it's always inside WhatsApp's 24h session
 * window — no Message Template is ever needed, and there's no background loop to start/stop.
 */
export interface ConnectorContext {
  /** Returns fresh, already-formatted Gmail context (e.g. recent/unread emails as plain text) — or
   * an honest "not connected yet" sentinel when Google hasn't been connected. Omit entirely for a
   * project with no Google connector wired in at all; a gmail-templated task then just answers
   * honestly that it isn't connected instead of failing. */
  gmail?: () => Promise<string>;
  calendar?: () => Promise<string>;
}

export interface CreateTaskRouterOptions {
  store: TaskStore;
  model: Model;
  connectors?: ConnectorContext;
  /** Below this confidence, treat it as "no match" and let the normal reactive agent handle the
   * message instead — this router never guesses at a task match. Default 0.6. */
  matchThreshold?: number;
}

export interface TaskRouteResult {
  handled: boolean;
  reply?: string;
  taskId?: string;
}

export interface TaskRouter {
  maybeHandle(message: InboundMessage): Promise<TaskRouteResult>;
}

const MatchSchema = z.object({
  taskId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

function matchPrompt(text: string, tasks: Task[]): string {
  const lines = [
    "The user has these saved productivity tasks. Decide whether their latest message is asking to run one of them right now.",
    ...tasks.map((t) => `- id: "${t.id}", label: "${t.title}"`),
    `User's message: "${text}"`,
    "Respond with the matching task's id (exactly as given above) and your confidence (0-1), or taskId: null if none of them apply — never guess at a low confidence.",
  ];
  return lines.join("\n");
}

const NO_MATCH: TaskRouteResult = { handled: false };

async function fetchContext(connector: "gmail" | "calendar", connectors?: ConnectorContext): Promise<string> {
  const fn = connector === "gmail" ? connectors?.gmail : connectors?.calendar;
  if (!fn) return connector === "gmail" ? "Gmail isn't connected yet." : "Calendar isn't connected yet.";
  try {
    return await fn();
  } catch (e) {
    return `Couldn't fetch ${connector} data right now: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function createTaskRouter(opts: CreateTaskRouterOptions): TaskRouter {
  const threshold = opts.matchThreshold ?? 0.6;

  return {
    async maybeHandle(message) {
      const text = message.text?.trim();
      if (!text) return NO_MATCH;

      const tasks = await opts.store.listByContact(message.contactId);
      if (tasks.length === 0) return NO_MATCH; // cheap, no model call — most messages aren't task-related

      let match: z.infer<typeof MatchSchema> | undefined;
      try {
        const result = await opts.model.generate({
          prompt: matchPrompt(text, tasks),
          responseSchema: z.toJSONSchema(MatchSchema),
        });
        const parsed = MatchSchema.safeParse(result.structured);
        if (parsed.success) match = parsed.data;
      } catch {
        return NO_MATCH; // a routing hiccup should never block the normal agent from answering
      }
      if (!match || !match.taskId || match.confidence < threshold) return NO_MATCH;

      const task = tasks.find((t) => t.id === match!.taskId);
      if (!task) return NO_MATCH; // model named an id that doesn't exist — fall back safely, don't guess

      const template = templateById(task.templateId);
      const instructions = buildInstructions(template, task.placeholders);
      const context = await fetchContext(template.connector, opts.connectors);

      try {
        // The task's fixed instructions set the baseline (what it always does); the contact's actual
        // live wording rides alongside it so extra detail they typed just now — "by topic," "last 2
        // days," anything not covered by the one saved placeholder — gets a real shot at being
        // honored, instead of being silently dropped the moment a match is found. It's still bounded
        // by whatever `context` was actually fetched (a fixed default window/count, not re-queried
        // per request) — told explicitly to say so rather than pretend the data supports more than
        // it does.
        const composed = await opts.model.generate({
          prompt: [
            instructions,
            "",
            `The contact's exact message just now: "${text}"`,
            "If it asks for something more specific than the instructions above (a topic grouping, a date range, a particular sender), honor it as far as the data below actually supports — and say plainly if the data doesn't cover what they asked, rather than guessing.",
            "",
            "Data:",
            context,
            "",
            "Reply as a short WhatsApp message — plain text, no markdown headers.",
          ].join("\n"),
        });
        const reply = composed.text?.trim();
        if (!reply) return NO_MATCH;
        return { handled: true, reply, taskId: task.id };
      } catch {
        return NO_MATCH; // same policy as a routing failure — let the normal agent take the message instead
      }
    },
  };
}
