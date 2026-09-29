import { randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import type { TemplateId } from "./templates.js";

/**
 * v2 redesign: a Task is a saved, reactive instruction, not a scheduled job — no `scheduleKind`,
 * no `status: on/off`, no run history. It either exists (and `router.ts` may match it against an
 * inbound message) or it's deleted. Simplicity over that on/off toggle deliberately — "let's keep it
 * extremely simple" — deleting is the only way to stop a task, no pause state to reason about.
 */
export interface Task {
  id: string;
  contactId: string;
  templateId: TemplateId;
  /** Denormalized display text (the filled-in sentence, e.g. "Find emails about invoices") — stored
   * at create/update time so the UI and any logging never need a template lookup just to show a task. */
  title: string;
  placeholders: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type NewTask = Pick<Task, "contactId" | "templateId" | "title" | "placeholders">;

export type TaskPatch = Partial<Pick<Task, "title" | "placeholders">>;

export type TaskStoreOptions = { url: string; authToken?: string } | { client: Client };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  contactId TEXT NOT NULL,
  templateId TEXT NOT NULL,
  title TEXT NOT NULL,
  placeholders TEXT NOT NULL,
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
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  };
}

export interface TaskStore {
  create(input: NewTask, now: number): Promise<Task>;
  listByContact(contactId: string): Promise<Task[]>;
  /** Every task, across all contacts — the local admin UI page (a single-operator tool, not a
   * per-contact login flow) shows everyone's tasks on one page. */
  listAll(): Promise<Task[]>;
  update(id: string, patch: TaskPatch, now: number): Promise<void>;
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
      const task: Task = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
      await client.execute({
        sql: "INSERT INTO tasks (id, contactId, templateId, title, placeholders, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [task.id, task.contactId, task.templateId, task.title, JSON.stringify(task.placeholders), task.createdAt, task.updatedAt],
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

    async update(id, patch, now) {
      await ensureSchema();
      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (patch.title !== undefined) { sets.push("title = ?"); args.push(patch.title); }
      if (patch.placeholders !== undefined) { sets.push("placeholders = ?"); args.push(JSON.stringify(patch.placeholders)); }
      if (sets.length === 0) return; // nothing to do — avoid a malformed "SET updatedAt = ?" only statement
      sets.push("updatedAt = ?");
      args.push(now, id);
      await client.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
    },

    async delete(id) {
      await ensureSchema();
      await client.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
    },
  };
}
