export interface ToolCall {
  name: string;
  args: unknown;
}
export type ModelStep =
  | { text: string }
  | { structured: unknown }
  | { toolCalls: ToolCall[] }
  | { error: Error }
  | { contextLengthError: true };
export interface ModelRequest {
  prompt: string;
  [k: string]: unknown;
}
export interface ModelResult {
  text?: string;
  structured?: unknown;
  toolCalls?: ToolCall[];
}

/** Scripted model: each generate() consumes the next step and records the request. */
export function mockModel(script: ModelStep[]) {
  const queue = [...script];
  const calls: ModelRequest[] = [];
  return {
    calls,
    async generate(req: ModelRequest): Promise<ModelResult> {
      calls.push(req);
      const step = queue.shift();
      if (!step) throw new Error(`mockModel: script exhausted at call ${calls.length}`);
      if ("error" in step) throw step.error;
      if ("contextLengthError" in step) {
        throw Object.assign(new Error("context length exceeded"), { code: "context_length_exceeded" });
      }
      return step;
    },
  };
}
