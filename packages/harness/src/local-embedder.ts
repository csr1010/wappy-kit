/**
 * A local, fully-offline embedding function for `createKnowledge`'s `embed` hook (§8 T8.3's own
 * "via the configured model provider" language deliberately left room for this) — no API key, no
 * per-call billing, no network call at inference time, matching this repo's own "nothing phones
 * home unless you tell it to" pitch. Runs `Xenova/all-MiniLM-L6-v2` (384-dim, small and fast — a
 * standard, well-regarded default for local semantic search) via `@huggingface/transformers`
 * (formerly `@xenova/transformers`; the Hugging Face-maintained current package).
 *
 * Honest caveat, not glossed over: the MODEL WEIGHTS are fetched from the Hugging Face Hub on first
 * use and cached locally afterward (same one-time-download-then-fully-offline shape as pulling an
 * Ollama model) — "local-first" describes every inference call after that, not a claim that zero
 * bytes ever cross the network, ever.
 */

export interface FeatureExtractionOutput {
  /** Flat Float32Array (or plain array) of `sentences.length * dimensions` numbers — the raw
   * pooled/normalized tensor data, exactly as `@huggingface/transformers`' pipeline returns it. */
  data: ArrayLike<number>;
  dims: number[];
}

/** The minimal slice of `@huggingface/transformers`' real pipeline this module actually calls —
 * kept as our own small interface (not the library's own type) so tests inject a fake conforming
 * to THIS shape and never trigger a real model download. */
export type FeatureExtractionPipeline = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<FeatureExtractionOutput>;

export interface LocalEmbedderOptions {
  /** Hugging Face model id. Default "Xenova/all-MiniLM-L6-v2". Changing this changes `dimensions`
   * too — inferred from the model's own output, never hardcoded, so any feature-extraction model
   * works, not just the default. */
  model?: string;
  /** Injectable — defaults to a real `pipeline("feature-extraction", model)` from
   * `@huggingface/transformers`, dynamically imported so this module (and anything that doesn't
   * exercise this exact branch) never requires the real package to resolve. Tests always inject a
   * fake pipeline here — no real model download happens in this repo's test suite. */
  pipelineFactory?: (model: string) => Promise<FeatureExtractionPipeline>;
}

export interface LocalEmbedder {
  /** Matches `KnowledgeOptions.embed`'s exact shape — pass this straight through. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** The model's actual output width, inferred from a real embedding call at creation time (not
   * hardcoded per model name) — feed this to `KnowledgeOptions.embedDimensions` for LibSQL-native
   * vector storage. */
  dimensions: number;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

async function realPipelineFactory(model: string): Promise<FeatureExtractionPipeline> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline("feature-extraction", model);
  return (texts, options) => extractor(texts, options) as unknown as Promise<FeatureExtractionOutput>;
}

function toNestedArrays(output: FeatureExtractionOutput): number[][] {
  const [count, dims] = output.dims;
  if (count === undefined || dims === undefined) {
    throw new Error(`createLocalEmbedder: unexpected output shape (dims: ${JSON.stringify(output.dims)}).`);
  }
  const flat = Array.from(output.data);
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) rows.push(flat.slice(i * dims, (i + 1) * dims));
  return rows;
}

/**
 * Builds a local, offline `embed` function (+ its output `dimensions`, inferred not hardcoded) for
 * `createKnowledge`. Runs one throwaway embedding at creation time specifically to learn
 * `dimensions` from the model's own real output — a small, one-time cost paid once per process, not
 * per `embed()` call.
 */
export async function createLocalEmbedder(opts: LocalEmbedderOptions = {}): Promise<LocalEmbedder> {
  const model = opts.model ?? DEFAULT_MODEL;
  const pipelineFactory = opts.pipelineFactory ?? realPipelineFactory;
  const extractor = await pipelineFactory(model);

  const embed = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return toNestedArrays(output);
  };

  const [warmup] = await embed(["_"]);
  if (!warmup) throw new Error(`createLocalEmbedder: the model "${model}" produced no output for a warm-up embedding call.`);

  return { embed, dimensions: warmup.length };
}
