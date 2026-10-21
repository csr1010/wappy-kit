import { MockLanguageModelV4 } from "ai/test";

/**
 * Stands in for the provider model (openai(...), anthropic(...), ollama(...)) inside an old
 * generated project, so it boots offline. Answers by the JSON schema asked for: the router gets a
 * confident "greeting" decision, compose gets a plain-text reply, anything else gets plain text.
 */
export function fakeProviderModel(reply: string) {
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }, warnings: [] });
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const format = (opts as { responseFormat?: { type: string; schema?: { properties?: Record<string, unknown> } } }).responseFormat;
      const props = format?.type === "json" ? Object.keys(format.schema?.properties ?? {}) : [];
      if (props.includes("intent")) return ok(JSON.stringify({ intent: "greeting", needsRAG: false, needsTool: false, escalate: false, confidence: 0.9 }));
      if (props.includes("formatRationale")) return ok(JSON.stringify({ formatRationale: "short greeting, plain text fits", message: { text: reply } }));
      return ok(reply);
    },
  });
}
