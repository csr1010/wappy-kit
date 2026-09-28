import { describe, expect, test } from "vitest";
import { SCHEDULED_MESSAGE_TEMPLATE } from "./whatsapp-template.js";

/** Found while hand-verifying Phase 3 against a real @wappy_ai/whatsapp channel: a proactive send
 * outside the 24h session window comes back "queued" unless a template is configured. This just
 * pins the shared constant's shape so create-agent's Phase 5 wiring and WHATSAPP_SETUP.md's
 * instructions can't silently drift apart from each other. */
describe("SCHEDULED_MESSAGE_TEMPLATE", () => {
  test("has a valid Meta template name (lowercase, underscores only)", () => {
    expect(SCHEDULED_MESSAGE_TEMPLATE.name).toMatch(/^[a-z0-9_]+$/);
  });

  test("category is 'utility', not 'marketing' — this is a scheduled notification, not promotional", () => {
    expect(SCHEDULED_MESSAGE_TEMPLATE.category).toBe("utility");
  });

  test("the body template text contains exactly one {{1}} placeholder, plus real static context", () => {
    const placeholderCount = (SCHEDULED_MESSAGE_TEMPLATE.bodyTemplateText.match(/\{\{1\}\}/g) ?? []).length;
    expect(placeholderCount).toBe(1);
    // Not an all-variable body — Meta is more likely to reject a template that gives its reviewer
    // (and the recipient) no static context at all.
    expect(SCHEDULED_MESSAGE_TEMPLATE.bodyTemplateText.replace("{{1}}", "").trim().length).toBeGreaterThan(0);
  });
});
