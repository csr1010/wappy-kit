import * as clack from "@clack/prompts";
import {
  applyAnswer,
  isComplete,
  nextQuestion,
  type CompleteInterviewAnswers,
  type InterviewAnswers,
  type ModelProvider,
  type ReferenceSkillName,
} from "./interview.js";

/**
 * The thin `@clack/prompts` layer T9.1 asked for — pure UI, zero validation or sequencing logic of
 * its own: `nextQuestion`/`applyAnswer`/`isComplete` (T9.1) drive everything, this module only
 * turns one step's `InterviewQuestionMeta` into the right clack prompt call and maps the raw answer
 * back into the typed shape `applyAnswer` expects. It never asks for a credential — those go in
 * `.env` (see the generated `.env.sample`). Not unit-tested against a real TTY; `cli.ts`'s
 * orchestration is tested with this whole function injected, and this module is tested by mocking
 * clack with a scripted response queue.
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

/** Runs the interactive interview (model, tools, and — only for Shopify — skills) and returns a
 * complete, valid `InterviewAnswers`; re-prompts a step on an invalid answer instead of ever exiting
 * mid-interview with a partial state. */
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
      case "tools":
        value = { kind: await selectOne<"none" | "shopify">(q.prompt, q.choices!) };
        break;
      case "skills": {
        const picked = await clack.multiselect({
          message: q.prompt,
          options: q.choices!.map((c) => ({ value: c.value, label: c.label })),
          required: false,
        });
        if (clack.isCancel(picked)) onCancel();
        value = { skills: picked as ReferenceSkillName[] };
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
