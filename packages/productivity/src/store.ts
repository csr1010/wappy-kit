import { randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import type { ScheduleKind, TemplateId } from "./templates.js";

export type TaskStatus = "on" | "off";
/** "queued" is distinct from "failed": the action ran fine and produced a real message, but WhatsApp's
 * 24h session-window rule means it was never actually sent (no open conversation, no approved Message
 * Template configured) — not an error to retry, just an honest "it didn't reach them" outcome. See
 * runner.ts's delivery-status handling. */
export type TaskLastStatus = "success" | "failed" | "queued";

export interface Task {
  id: string;
  contactId: string;
  templateId: TemplateId;
  title: string;
  placeholders: Record<string, string>;
  scheduleKind: ScheduleKind;
  /** "HH:MM" for `dailyAt`, an ISO timestamp for `once`. */
  scheduleValue: string;
  status: TaskStatus;
  lastRunAt?: number;
  lastStatus?: TaskLastStatus;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export type NewTask = Pick<Task, "contactId" | "templateId" | "title" | "placeholders" | "scheduleKind" | "scheduleValue">;

export type TaskPatch = Partial<Pick<Task, "title" | "placeholders" | "scheduleKind" | "scheduleValue" | "lastRunAt" | "lastStatus" | "retryCount">>;

export type TaskStoreOptions = { url: string; authToken?: string } | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  contactId TEXT NOT NULL,
  templateId TEXT NOT NULL,
  title TEXT NOT NULL,
  placeholders TEXT NOT NULL,
  scheduleKind TEXT NOT NULL,
  scheduleValue TEXT NOT NULL,
  status TEXT NOT NULL,
  lastRunAt INTEGER,
  lastStatus TEXT,
  retryCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
`;

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    contactId: row.contactId as string,
    templateId: row.templateId as TemplateId,
    title: row.title as string,
    placeholders: JSON.parse(row.placeholders as string) as Record<string, string>,
    scheduleKind: row.scheduleKind as ScheduleKind,
    scheduleValue: row.scheduleValue as string,
    status: row.status as TaskStatus,
    ...(row.lastRunAt !== null ? { lastRunAt: row.lastRunAt as number } : {}),
    ...(row.lastStatus !== null ? { lastStatus: row.lastStatus as TaskLastStatus } : {}),
    retryCount: row.retryCount as number,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  };
}

export interface TaskStore {
  create(input: NewTask, now: number): Promise<Task>;
  listByContact(contactId: string): Promise<Task[]>;
  /** Every task, across all contacts, regardless of status — Phase 4's local admin UI page (a
   * single-operator tool, not a per-contact login flow) shows everyone's tasks on one page. */
  listAll(): Promise<Task[]>;
  /** Every `status: 'on'` task, across all contacts — what the runner (Phase 2) scans each tick. */
  listActive(): Promise<Task[]>;
  update(id: string, patch: TaskPatch, now: number): Promise<void>;
  setStatus(id: string, status: TaskStatus, now: number): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * LibSQL-backed `TaskStore` — same client/schema pattern as `@wappy_ai/harness`'s
 * `createLibsqlSessionProfileStore` (`createClient`/`Client`, one `CREATE TABLE IF NOT EXISTS`
 * schema, a lazily-initialized `ensureSchema()`, plain parameterized `client.execute()` calls). Own
 * table, own local file (`.wappy/tasks.db` by convention) — a distinct concern from conversation
 * memory or the session profile.
 */
export function createTaskStore(opts: TaskStoreOptions): TaskStore {
  const client: Client = "client" in opts ? opts.client : createClient({ url: opts.url, authToken: opts.authToken });
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(SCHEMA).catch((e: unknown) => {
        ready = undefined; // let the next call retry instead of permanently caching a transient failure
        throw e;
      });
    }
    return ready;
  };

  return {
    async create(input, now) {
      await ensureSchema();
      const task: Task = { ...input, id: randomUUID(), status: "on", retryCount: 0, createdAt: now, updatedAt: now };
      await client.execute({
        sql: "INSERT INTO tasks (id, contactId, templateId, title, placeholders, scheduleKind, scheduleValue, status, retryCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [task.id, task.contactId, task.templateId, task.title, JSON.stringify(task.placeholders), task.scheduleKind, task.scheduleValue, task.status, task.retryCount, task.createdAt, task.updatedAt],
      });
      return task;
    },

    async listByContact(contactId) {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT * FROM tasks WHERE contactId = ? ORDER BY createdAt ASC", args: [contactId] });
      return result.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
    },

    async listAll() {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT * FROM tasks ORDER BY createdAt ASC" });
      return result.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
    },

    async listActive() {
      await ensureSchema();
      const result = await client.execute({ sql: "SELECT * FROM tasks WHERE status = 'on' ORDER BY createdAt ASC" });
      return result.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
    },

    async update(id, patch, now) {
      await ensureSchema();
      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
      if (patch.placeholders !== undefined) { sets.push("placeholders = ?"); args.push(JSON.stringify(patch.placeholders)); }
      if (patch.scheduleKind !== undefined) { sets.push("scheduleKind = ?"); args.push(patch.scheduleKind); }
      if (patch.scheduleValue !== undefined) { sets.push("scheduleValue = ?"); args.push(patch.scheduleValue); }
      if (patch.lastRunAt !== undefined) { sets.push("lastRunAt = ?"); args.push(patch.lastRunAt); }
      if (patch.lastStatus !== undefined) { sets.push("lastStatus = ?"); args.push(patch.lastStatus); }
      if (patch.retryCount !== undefined) { sets.push("retryCount = ?"); args.push(patch.retryCount); }
      if (sets.length === 0) return; // nothing to do — avoid a malformed "SET updatedAt = ?" only statement
      sets.push("updatedAt = ?");
      args.push(now, id);
      await client.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
    },

    async setStatus(id, status, now) {
      await ensureSchema();
      await client.execute({ sql: "UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?", args: [status, now, id] });
    },

    async delete(id) {
      await ensureSchema();
      await client.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
    },
  };
}
