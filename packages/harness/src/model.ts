import { generateObject, generateText, jsonSchema, NoObjectGeneratedError, stepCountIs, tool, type JSONSchema7, type LanguageModel, type ModelMessage } from "ai";
import type { Model, ModelRequest, ModelResult, Turn } from "@wappy/core";

export interface VercelModelOptions {
  /** Any Vercel AI SDK LanguageModel — providers (OpenAI/Anthropic/Gemini/Ollama) are config passed in here, not code in this file (§2.1). */
  model: LanguageModel;
  /** Aborts the call after this many ms (§10 "model API error/timeout -> retry/backoff"). */
  timeoutMs?: number;
  /** Max model round-trips when tools are involved: 1 tool-call step + follow-up steps where the
   * model sees results and composes its final reply (§9 Scenario C). Default 5. */
  maxToolSteps?: number;
  /** Retries a transient failure (429/5xx) with backoff before giving up — delegated to the AI
   * SDK's own retry handling rather than reimplemented here (§10 "429 -> backoff retry"). SDK
   * default (2) if unset. */
  maxRetries?: number;
}

function toModelMessages(history: Turn[]): ModelMessage[] {
  return history
    .filter((t): t is Turn & { text: string } => Boolean(t.text))
    .map((t) => ({ role: t.role === "agent" ? "assistant" : t.role === "system" ? "system" : "user", content: t.text }));
}

/** The model port — wraps the Vercel AI SDK behind core's `Model` interface (§2.1, §3). */
export function createVercelModel(opts: VercelModelOptions): Model {
  return {
    async generate(req: ModelRequest): Promise<ModelResult> {
      const abortSignal = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined;
      const messages: ModelMessage[] = [...toModelMessages(req.history ?? []), { role: "user", content: req.prompt }];

      if (req.responseSchema) {
        try {
          const result = await generateObject({ model: opts.model, messages, schema: jsonSchema(req.responseSchema as JSONSchema7), abortSignal, allowSystemInMessages: true, maxRetries: opts.maxRetries });
          return { structured: result.object };
        } catch (e) {
          // On a schema-validation failure, generateObject() throws rather than resolving with a
          // usable result — but the model may still have produced perfectly fine free text (its raw
          // attempt). Surface that as `text` so a caller like compose.ts's repair-then-degrade can
          // actually use it, instead of losing it behind a generic thrown error.
          if (NoObjectGeneratedError.isInstance(e) && e.text) return { text: e.text };
          throw e;
        }
      }

      if (req.tools && req.tools.length > 0) {
        const tools = Object.fromEntries(
          req.tools.map((t) => [
            t.name,
            tool({
              description: t.description,
              inputSchema: jsonSchema(t.parameters as JSONSchema7),
              execute: (args) => t.execute(args),
            }),
          ]),
        );
        const result = await generateText({ model: opts.model, messages, tools, stopWhen: stepCountIs(opts.maxToolSteps ?? 5), abortSignal, allowSystemInMessages: true, maxRetries: opts.maxRetries });
        const toolCalls = result.toolCalls.map((c) => ({ name: c.toolName, args: c.input }));
        return toolCalls.length > 0 ? { text: result.text || undefined, toolCalls } : { text: result.text };
      }

      const result = await generateText({ model: opts.model, messages, abortSignal, allowSystemInMessages: true, maxRetries: opts.maxRetries });
      return { text: result.text };
    },
  };
}
