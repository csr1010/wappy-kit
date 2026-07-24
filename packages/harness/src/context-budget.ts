/** Estimates a text's token count. Under-counting causes real overflow failures; over-counting only
 * costs a little history — so a conservative (round-up) estimate is always preferred (§10). */
export interface TokenEstimator {
  estimate(text: string): number;
}

/** Conservative fallback: ~3.5 chars/token, rounded up. No tokenizer dependency required. */
export const charsPerTokenEstimator: TokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 3.5),
};

export interface ModelWindowConfig {
  /** Total tokens the model's context window supports. */
  contextWindow: number;
  /** Tokens reserved for the model's own output — never counted as available for the prompt. */
  reservedOutputTokens: number;
}

/** Sane defaults for common models — not exhaustive; an unrecognized model id falls back to
 * CONSERVATIVE_DEFAULT rather than guessing too large and risking a real overflow. */
const KNOWN_MODEL_WINDOWS: Record<string, ModelWindowConfig> = {
  "gpt-4o": { contextWindow: 128_000, reservedOutputTokens: 4_096 },
  "gpt-4o-mini": { contextWindow: 128_000, reservedOutputTokens: 4_096 },
  "gpt-4-turbo": { contextWindow: 128_000, reservedOutputTokens: 4_096 },
  "claude-3-5-sonnet": { contextWindow: 200_000, reservedOutputTokens: 8_192 },
  "claude-3-5-haiku": { contextWindow: 200_000, reservedOutputTokens: 8_192 },
  "claude-3-opus": { contextWindow: 200_000, reservedOutputTokens: 4_096 },
  "gemini-1.5-pro": { contextWindow: 2_000_000, reservedOutputTokens: 8_192 },
  "gemini-1.5-flash": { contextWindow: 1_000_000, reservedOutputTokens: 8_192 },
  llama3: { contextWindow: 8_192, reservedOutputTokens: 2_048 },
};

const CONSERVATIVE_DEFAULT: ModelWindowConfig = { contextWindow: 8_000, reservedOutputTokens: 1_000 };

export interface ContextBudget {
  estimator: TokenEstimator;
  /** Tokens available for the whole assembled PROMPT (context window minus reserved output). */
  promptBudget: number;
}

export interface ContextBudgetOptions {
  estimator?: TokenEstimator;
  overrides?: Partial<ModelWindowConfig>;
}

/** Builds a ContextBudget for a model id (§10 "prompt/token overflow -> tool retrieval + curation"). */
export function createContextBudget(modelId: string, opts: ContextBudgetOptions = {}): ContextBudget {
  const config: ModelWindowConfig = { ...(KNOWN_MODEL_WINDOWS[modelId] ?? CONSERVATIVE_DEFAULT), ...opts.overrides };
  return {
    estimator: opts.estimator ?? charsPerTokenEstimator,
    promptBudget: config.contextWindow - config.reservedOutputTokens,
  };
}
