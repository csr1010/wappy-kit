import { describe, expect, test } from "vitest";
import { DEFAULT_ANSWERS, type CompleteInterviewAnswers } from "./interview.js";
import { renderProject, type PartVersions } from "./templates.js";

/**
 * M14 addition: the WhatsApp Cloud API + webhook walkthrough moved out of README.md into its own
 * generated file (WHATSAPP_SETUP.md), per direct user feedback that this step deserves a real,
 * followable walkthrough rather than being buried in a skimmable README. See templates.m9.test.ts's
 * updated file-list assertion (--allow-test-change, same reason) for the sibling change.
 */

const VERSIONS: PartVersions = { core: "0.1.0", harness: "0.1.0", whatsapp: "0.1.0", createWappy: "0.1.0" };

function complete(): CompleteInterviewAnswers {
  return { model: DEFAULT_ANSWERS.model };
}

function fileMap(files: { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("renderProject — WHATSAPP_SETUP.md", () => {
  const files = fileMap(renderProject({ answers: complete(), versions: VERSIONS }));
  const setup = files.get("WHATSAPP_SETUP.md")!;

  test("is generated", () => {
    expect(setup).toBeTruthy();
  });

  test("covers creating the Meta app and getting real credentials", () => {
    expect(setup).toContain("developers.facebook.com/apps");
    expect(setup).toContain("WHATSAPP_PHONE_NUMBER_ID");
    expect(setup).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(setup).toContain("WHATSAPP_APP_SECRET");
    expect(setup).toContain("WHATSAPP_VERIFY_TOKEN");
  });

  test("covers getting a public webhook URL from a local machine", () => {
    expect(setup).toContain("npm run dev");
    expect(setup).toContain("/webhook");
    expect(setup).toMatch(/tunnel/i);
  });

  test("covers wiring the URL into Meta's webhook config, including subscribing to messages", () => {
    expect(setup).toMatch(/Verify/);
    expect(setup).toContain("messages");
  });

  test("README points here instead of repeating the walkthrough", () => {
    const readme = files.get("README.md")!;
    expect(readme).toContain("WHATSAPP_SETUP.md");
    expect(readme).not.toContain("developers.facebook.com/apps");
  });
});
