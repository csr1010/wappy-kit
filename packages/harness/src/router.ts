import { z } from "zod";
import { RouterDecisionSchema, type Model, type Router, type RouterDecision, type RouterInput } from "@wappy/core";

const routerDecisionJsonSchema = z.toJSONSchema(RouterDecisionSchema);

/** Picked when the model's output is unusable after a repair attempt: general/no-skill/no-tool,
 * low confidence, never auto-escalated — the cheapest, safest fallback path (§10 "garbage/invalid
 * output -> safe default"). */
const SAFE_DEFAULT: RouterDecision = { intent: "general", needsRAG: false, needsTool: false, escalate: false, confidence: 0 };

export interface LlmRouterOptions {
  model: Model;
  /** Overrides the default prompt built from RouterInput. */
  buildPrompt?: (input: RouterInput) => string;
}

function defaultPrompt(input: RouterInput): string {
  const lines = [
    "You are the routing classifier for a WhatsApp support agent.",
    `Available skills: ${input.availableSkills.join(", ") || "(none)"}`,
    `Available tools: ${input.availableTools.join(", ") || "(none)"}`,
    "Recent history:",
    ...input.history.slice(-5).map((t) => `${t.role}: ${t.text ?? "(no text)"}`),
    `Latest message: ${input.message.text ?? "(no text)"}`,
    "Decide: intent (short label), an optional skill name (must be one of the available skills), whether RAG/a tool is needed, whether to escalate to a human, and your confidence (0-1).",
  ];
  return lines.join("\n");
}

/** LLM-based Router (§7 default implementation): typed structured output, one repair attempt on
 * malformed output, then a safe default rather than crashing or guessing. */
export function createLlmRouter(opts: LlmRouterOptions): Router {
  const buildPrompt = opts.buildPrompt ?? defaultPrompt;
  return {
    async route(input) {
      const prompt = buildPrompt(input);
      for (let attempt = 0; attempt < 2; attempt++) {
        let structured: unknown;
        try {
          structured = (await opts.model.generate({ prompt, responseSchema: routerDecisionJsonSchema })).structured;
        } catch {
          continue; // model error is treated the same as malformed output — try once more, then fall back
        }
        const parsed = RouterDecisionSchema.safeParse(structured);
        if (parsed.success) return parsed.data;
      }
      return SAFE_DEFAULT;
    },
  };
}
