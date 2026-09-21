import * as clack from "@clack/prompts";
import {
  applyAnswer,
  isComplete,
  nextQuestion,
  type CompleteInterviewAnswers,
  type FrameworkChoice,
  type InterviewAnswers,
  type MemoryBackend,
  type ModelProvider,
  type ReferenceSkillName,
} from "./interview.js";

/**
 * The thin `@clack/prompts` layer T9.1 asked for — pure UI, zero validation or sequencing logic of
 * its own: `nextQuestion`/`applyAnswer`/`isComplete` (T9.1) drive everything, this module only
 * turns one step's `InterviewQuestionMeta` into the right clack prompt call(s) and maps the raw
 * answer back into the typed shape `applyAnswer` expects. Not unit-tested directly (clack reads/
 * writes a real TTY) — `cli.ts`'s orchestration around this is tested instead, with this whole
 * function injected as a fake. See the milestone brief's own "most of this milestone is testable
 * without a TTY."
 */

function onCancel(): never {
  clack.cancel("Setup cancelled.");
  process.exit(1);
}

async function selectOne<T extends string>(message: string, choices: { value: string; label: string }[]): Promise<T> {
  const choice = await clack.select({ message, options: choices.map((c) => ({ value: c.value, label: c.label })) });
  if (clack.isCancel(choice)) onCancel();
  return choice as T;
}

async function promptText(message: string, placeholder?: string): Promise<string> {
  const value = await clack.text({ message, placeholder });
  if (clack.isCancel(value)) onCancel();
  return value;
}

/** Runs the full interactive interview (§4.1's 7 steps, in order) and returns a complete, valid
 * `InterviewAnswers` — re-prompts a step on an invalid answer (e.g. Jev without a key path) instead
 * of ever exiting mid-interview with a partial/invalid state. */
export async function runInteractiveInterview(): Promise<CompleteInterviewAnswers> {
  clack.intro("create-wappy — let's set up your WhatsApp agent");
  let answers: InterviewAnswers = {};

  while (!isComplete(answers)) {
    const q = nextQuestion(answers)!;
    let value: InterviewAnswers[typeof q.step];

    switch (q.step) {
      case "model":
        value = { provider: await selectOne<ModelProvider>(q.prompt, q.choices!) };
        break;
      case "framework":
        value = { framework: await selectOne<FrameworkChoice>(q.prompt, q.choices!) };
        break;
      case "skills": {
        const picked = await clack.multiselect({
          message: q.prompt,
          options: q.choices!.filter((c) => c.value !== "none").map((c) => ({ value: c.value, label: c.label })),
          required: false,
        });
        if (clack.isCancel(picked)) onCancel();
        value = { skills: picked as ReferenceSkillName[] };
        break;
      }
      case "tools": {
        const kind = await selectOne<"none" | "openapi" | "shopify">(q.prompt, q.choices!);
        if (kind === "shopify") {
          const storeDomain = await promptText("Shopify store domain", "my-shop.myshopify.com");
          value = { kind: "shopify", storeDomain };
        } else if (kind === "openapi") {
          const source = await promptText("OpenAPI/Swagger spec URL or file path");
          value = { kind: "openapi", source };
        } else {
          value = { kind: "none" };
        }
        break;
      }
      case "memory":
        value = { backend: await selectOne<MemoryBackend>(q.prompt, q.choices!) };
        break;
      case "router": {
        const router = await selectOne<"llm" | "jev">(q.prompt, q.choices!);
        value = router === "jev" ? { router: "jev", jevKeyPath: await promptText("Path to your Jev key file") } : { router: "llm" };
        break;
      }
      case "whatsapp": {
        const mode = await selectOne<"now" | "later">(q.prompt, q.choices!);
        if (mode === "now") {
          value = {
            mode: "now",
            phoneNumberId: await promptText("WhatsApp phone number id"),
            accessToken: await promptText("WhatsApp access token"),
            verifyToken: await promptText("Webhook verify token (any string you choose)"),
          };
        } else {
          value = { mode: "later" };
        }
        break;
      }
    }

    const result = applyAnswer(answers, q.step, value);
    if (!result.ok) {
      clack.log.error(result.errors.join("\n"));
      continue;
    }
    answers = result.answers;
  }

  clack.outro("Interview complete — generating your project...");
  return answers as CompleteInterviewAnswers;
}
