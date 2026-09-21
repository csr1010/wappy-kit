import { SmartMessageSchema, smartMessageJsonSchema, type Model, type SmartMessage, type Turn } from "@wappy/core";

export interface ComposeOptions {
  model: Model;
  prompt: string;
  history?: Turn[];
}

const REPAIR_NOTE = "\n\n(Your previous reply didn't match the required JSON schema — respond again with valid JSON only.)";
const FALLBACK_TEXT = "Sorry, I'm having trouble putting together a reply right now — please try again shortly.";

/**
 * Asks the model for a SmartMessage via structured output; one repair attempt on invalid output
 * (a model throw counts as invalid too); if still invalid after the repair, degrades to whatever
 * free text either attempt produced (most recent wins), never a silent/empty reply (§10, T5.6).
 */
export async function composeSmartMessage(opts: ComposeOptions): Promise<SmartMessage> {
  let lastText: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? opts.prompt : opts.prompt + REPAIR_NOTE;
    try {
      const result = await opts.model.generate({ prompt, history: opts.history, responseSchema: smartMessageJsonSchema });
      if (result.text) lastText = result.text;
      const parsed = SmartMessageSchema.safeParse(result.structured);
      if (parsed.success) return parsed.data;
    } catch {
      // treated the same as malformed output — try the repair attempt, then degrade
    }
  }
  return { text: lastText ?? FALLBACK_TEXT };
}
