import * as clack from "@clack/prompts";
import { applyAnswer, isComplete, nextQuestion, type CompleteInterviewAnswers, type InterviewAnswers, type ModelProvider } from "./interview.js";

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

async function selectOne<T extends string>(message: string, choices: { value: string; label: string; hint?: string }[]): Promise<T> {
  const choice = await clack.select({ message, options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) });
  if (clack.isCancel(choice)) onCancel();
  return choice as T;
}

/**
 * Runs the interactive interview (`model`, `memory`, `productivity`) and returns a complete, valid
 * `InterviewAnswers`. No "re-prompt on an invalid answer" loop here: `applyAnswer` can never reject
 * what `selectOne` returns (it's always one of the choices clack was given), so that branch would be
 * dead code, not real defensiveness.
 */
export async function runInteractiveInterview(): Promise<CompleteInterviewAnswers> {
  clack.intro("Wappy agent setup — let's set up your WhatsApp agent");
  let answers: InterviewAnswers = {};

  while (!isComplete(answers)) {
    const q = nextQuestion(answers)!;
    let value: InterviewAnswers[typeof q.step];

    switch (q.step) {
      case "model":
        value = { provider: await selectOne<ModelProvider>(q.prompt, q.choices!) };
        break;
      case "memory":
        value = { backend: await selectOne<"local" | "cognee">(q.prompt, q.choices!) };
        break;
      case "productivity":
        value = { enabled: (await selectOne<"yes" | "no">(q.prompt, q.choices!)) === "yes" };
        break;
    }

    const result = applyAnswer(answers, q.step, value);
    if (!result.ok) throw new Error(`unreachable: ${result.errors.join("\n")}`);
    answers = result.answers;
  }

  clack.outro("Interview complete — generating your project...");
  return answers as CompleteInterviewAnswers;
}
