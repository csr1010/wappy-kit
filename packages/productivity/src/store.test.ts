import { describe, expect, test } from "vitest";
import { createTaskStore, type NewTask } from "./store.js";
import { buildInstructions, TASK_TEMPLATES, templateById } from "./templates.js";

/** v2 (plan pivot: reactive tasks, no scheduling — "we should not setup cron or templates"). */

function freshStore() {
  return createTaskStore({ url: ":memory:" });
}

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    contactId: "+15550001111",
    templateId: "find_emails",
    title: "Find emails about invoices",
    placeholders: { query: "invoices" },
    ...overrides,
  };
}

describe("createTaskStore", () => {
  test("create then listByContact returns it", async () => {
    const store = freshStore();
    const created = await store.create(newTask(), 1000);
    const list = await store.listByContact(created.contactId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
  });

  test("two different contactIds never see each other's tasks", async () => {
    const store = freshStore();
    await store.create(newTask({ contactId: "+1111" }), 1000);
    await store.create(newTask({ contactId: "+2222" }), 1000);
    expect(await store.listByContact("+1111")).toHaveLength(1);
    expect(await store.listByContact("+2222")).toHaveLength(1);
    expect((await store.listByContact("+1111"))[0]!.contactId).toBe("+1111");
  });

  test("update() persists a placeholder change", async () => {
    const store = freshStore();
    const created = await store.create(newTask(), 1000);
    await store.update(created.id, { placeholders: { query: "travel" }, title: "Find emails about travel" }, 2000);
    const [updated] = await store.listByContact(created.contactId);
    expect(updated!.placeholders).toEqual({ query: "travel" });
    expect(updated!.title).toBe("Find emails about travel");
    expect(updated!.updatedAt).toBe(2000);
  });

  test("delete removes the task", async () => {
    const store = freshStore();
    const created = await store.create(newTask(), 1000);
    await store.delete(created.id);
    expect(await store.listByContact(created.contactId)).toHaveLength(0);
  });

  test("listAll returns every task across every contact", async () => {
    const store = freshStore();
    await store.create(newTask({ contactId: "+1111" }), 1000);
    await store.create(newTask({ contactId: "+2222" }), 1000);
    expect(await store.listAll()).toHaveLength(2);
  });
});

describe("TASK_TEMPLATES", () => {
  test("all 4 templates have a valid id/label/placeholder shape, at most one placeholder each", () => {
    expect(TASK_TEMPLATES).toHaveLength(4);
    for (const t of TASK_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.placeholders.length).toBeLessThanOrEqual(1);
      expect(["gmail", "calendar"]).toContain(t.connector);
      expect(typeof t.repeatable).toBe("boolean");
    }
  });

  test("find_emails and find_events are repeatable (you'd want several with different filters); summarize_emails/daily_meetings are not", () => {
    const repeatable = TASK_TEMPLATES.filter((t) => t.repeatable).map((t) => t.id);
    expect(repeatable.sort()).toEqual(["find_emails", "find_events"]);
  });

  test("every template's sentence contains a {key} token for each of its placeholders, and no others", () => {
    for (const t of TASK_TEMPLATES) {
      const tokens = [...t.sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(tokens.sort()).toEqual(t.placeholders.map((p) => p.key).sort());
    }
  });

  test("templateById returns the matching template, throws for an unknown id", () => {
    expect(templateById("find_emails").label).toBe("Find emails about");
    // @ts-expect-error deliberately invalid id
    expect(() => templateById("not-a-real-template")).toThrow(/unknown template id/);
  });
});

describe("buildInstructions — defaults when a placeholder is left blank", () => {
  test("summarize_emails with no 'from' filter defaults to unfiltered unread inbox", () => {
    const text = buildInstructions(templateById("summarize_emails"), { from: "" });
    expect(text).not.toContain("from ");
    expect(text).toContain("unread emails");
  });

  test("summarize_emails with a 'from' filter mentions it", () => {
    const text = buildInstructions(templateById("summarize_emails"), { from: "boss@example.com" });
    expect(text).toContain("from boss@example.com");
  });

  test("find_emails with no query defaults to no topic filter, still asks for at most 5", () => {
    const text = buildInstructions(templateById("find_emails"), { query: "" });
    expect(text).not.toContain("about ");
    expect(text).toContain("at most 5");
  });

  test("daily_meetings with no 'when' defaults to 'today'", () => {
    const text = buildInstructions(templateById("daily_meetings"), { when: "" });
    expect(text).toContain("for today");
  });

  test("daily_meetings with an explicit 'when' uses it instead of the default", () => {
    const text = buildInstructions(templateById("daily_meetings"), { when: "tomorrow" });
    expect(text).toContain("for tomorrow");
    expect(text).not.toContain("for today");
  });

  test("find_events with a query mentions it", () => {
    const text = buildInstructions(templateById("find_events"), { query: "offsite" });
    expect(text).toContain("about offsite");
  });
});
