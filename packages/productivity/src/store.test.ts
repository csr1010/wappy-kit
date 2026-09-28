import { describe, expect, test } from "vitest";
import { createTaskStore, type NewTask } from "./store.js";
import { TASK_TEMPLATES, templateById } from "./templates.js";

/** Phase 1 (plan: "Task store — backend only, no UI, no scheduling execution yet"). */

function freshStore() {
  return createTaskStore({ url: ":memory:" });
}

function newReminder(overrides: Partial<NewTask> = {}): NewTask {
  return {
    contactId: "+15550001111",
    templateId: "reminder",
    title: "Remind me about call mom",
    placeholders: { text: "call mom", time: "17:00" },
    scheduleKind: "dailyAt",
    scheduleValue: "17:00",
    ...overrides,
  };
}

describe("createTaskStore", () => {
  test("create then listByContact returns it", async () => {
    const store = freshStore();
    const created = await store.create(newReminder(), 1000);
    const list = await store.listByContact(created.contactId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
    expect(created.status).toBe("on");
    expect(created.retryCount).toBe(0);
  });

  test("two different contactIds never see each other's tasks", async () => {
    const store = freshStore();
    await store.create(newReminder({ contactId: "+1111" }), 1000);
    await store.create(newReminder({ contactId: "+2222" }), 1000);
    expect(await store.listByContact("+1111")).toHaveLength(1);
    expect(await store.listByContact("+2222")).toHaveLength(1);
    expect((await store.listByContact("+1111"))[0]!.contactId).toBe("+1111");
  });

  test("update() persists a placeholder change", async () => {
    const store = freshStore();
    const created = await store.create(newReminder(), 1000);
    await store.update(created.id, { placeholders: { text: "call dad", time: "18:00" } }, 2000);
    const [updated] = await store.listByContact(created.contactId);
    expect(updated!.placeholders).toEqual({ text: "call dad", time: "18:00" });
    expect(updated!.updatedAt).toBe(2000);
  });

  test("setStatus round-trips off then on", async () => {
    const store = freshStore();
    const created = await store.create(newReminder(), 1000);
    await store.setStatus(created.id, "off", 1500);
    expect((await store.listByContact(created.contactId))[0]!.status).toBe("off");
    await store.setStatus(created.id, "on", 1600);
    expect((await store.listByContact(created.contactId))[0]!.status).toBe("on");
  });

  test("delete removes the task", async () => {
    const store = freshStore();
    const created = await store.create(newReminder(), 1000);
    await store.delete(created.id);
    expect(await store.listByContact(created.contactId)).toHaveLength(0);
  });

  test("listActive returns only status:'on' tasks, across all contacts", async () => {
    const store = freshStore();
    const a = await store.create(newReminder({ contactId: "+1111" }), 1000);
    await store.create(newReminder({ contactId: "+2222" }), 1000);
    await store.setStatus(a.id, "off", 1500);
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.contactId).toBe("+2222");
  });

  test("listAll returns every task across every contact, regardless of status", async () => {
    const store = freshStore();
    const a = await store.create(newReminder({ contactId: "+1111" }), 1000);
    await store.create(newReminder({ contactId: "+2222" }), 1000);
    await store.setStatus(a.id, "off", 1500);
    expect(await store.listAll()).toHaveLength(2);
  });
});

describe("TASK_TEMPLATES", () => {
  test("all 5 templates have a valid id/label/placeholder shape", () => {
    expect(TASK_TEMPLATES).toHaveLength(5);
    for (const t of TASK_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(Array.isArray(t.placeholders)).toBe(true);
      for (const p of t.placeholders) {
        expect(p.key).toBeTruthy();
        expect(["text", "time"]).toContain(p.kind);
      }
    }
  });

  test("templateById returns the matching template, throws for an unknown id", () => {
    expect(templateById("reminder").label).toBe("Remind me about");
    // @ts-expect-error deliberately invalid id
    expect(() => templateById("not-a-real-template")).toThrow(/unknown template id/);
  });

  test("only the 2 zero-external-account templates are marked as not requiring Google", () => {
    const noGoogle = TASK_TEMPLATES.filter((t) => !t.requiresGoogle).map((t) => t.id);
    expect(noGoogle.sort()).toEqual(["reminder", "wake_me_up"]);
  });
});
