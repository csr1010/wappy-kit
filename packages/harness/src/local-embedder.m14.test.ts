import { describe, expect, test } from "vitest";
import { createLocalEmbedder, type FeatureExtractionPipeline } from "./local-embedder.js";

/**
 * `pipelineFactory` is always injected here — no real `@huggingface/transformers` model download
 * happens in this test file (matches this repo's "no live network in tests" discipline). The real
 * factory (`realPipelineFactory`, a dynamic import of the actual package) is isolated to one small,
 * unexported function specifically so nothing else needs to touch the real package to be tested.
 */

function fakePipeline(dims: number, valueFor: (text: string, dim: number) => number = () => 0): FeatureExtractionPipeline {
  return async (texts) => {
    const data: number[] = [];
    for (const t of texts) for (let d = 0; d < dims; d++) data.push(valueFor(t, d));
    return { data, dims: [texts.length, dims] };
  };
}

describe("createLocalEmbedder — embed()", () => {
  test("returns one row per input text, each row `dimensions` long", async () => {
    const embedder = await createLocalEmbedder({ pipelineFactory: async () => fakePipeline(4) });
    const rows = await embedder.embed(["a", "b", "c"]);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveLength(4);
  });

  test("un-flattens the pipeline's flat tensor data correctly, per input", async () => {
    // valueFor makes each text's row identifiable: text "a" -> [0,0,...], text "b" -> [1,1,...]
    const embedder = await createLocalEmbedder({ pipelineFactory: async () => fakePipeline(3, (t) => (t === "b" ? 1 : 0)) });
    const [a, b] = await embedder.embed(["a", "b"]);
    expect(a).toEqual([0, 0, 0]);
    expect(b).toEqual([1, 1, 1]);
  });

  test("embed([]) returns [] without calling the pipeline at all", async () => {
    let called = false;
    const embedder = await createLocalEmbedder({
      pipelineFactory: async () => {
        return async (texts, options) => {
          called = true;
          return fakePipeline(2)(texts, options);
        };
      },
    });
    called = false; // reset: creation itself does a warm-up embed() call, which is expected to call the pipeline
    expect(await embedder.embed([])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("createLocalEmbedder — dimensions inferred from real output, not hardcoded", () => {
  test("dimensions matches whatever the (fake) model actually produces", async () => {
    const embedder384 = await createLocalEmbedder({ pipelineFactory: async () => fakePipeline(384) });
    expect(embedder384.dimensions).toBe(384);

    const embedder768 = await createLocalEmbedder({ pipelineFactory: async () => fakePipeline(768) });
    expect(embedder768.dimensions).toBe(768);
  });
});

describe("createLocalEmbedder — model selection", () => {
  test("passes the configured model name to pipelineFactory; defaults to Xenova/all-MiniLM-L6-v2", async () => {
    let seenModel: string | undefined;
    await createLocalEmbedder({
      pipelineFactory: async (model) => {
        seenModel = model;
        return fakePipeline(4);
      },
    });
    expect(seenModel).toBe("Xenova/all-MiniLM-L6-v2");

    let seenCustom: string | undefined;
    await createLocalEmbedder({
      model: "Xenova/all-mpnet-base-v2",
      pipelineFactory: async (model) => {
        seenCustom = model;
        return fakePipeline(4);
      },
    });
    expect(seenCustom).toBe("Xenova/all-mpnet-base-v2");
  });
});

describe("createLocalEmbedder — a model producing no usable output fails loud at creation time", () => {
  test("an empty warm-up result throws a clear error rather than silently reporting dimensions: 0", async () => {
    await expect(
      createLocalEmbedder({
        pipelineFactory: async () => async () => ({ data: [], dims: [0, 0] }),
      }),
    ).rejects.toThrow(/produced no output/);
  });

  test("a malformed (too-short) dims array from the pipeline fails loud too, not with a confusing downstream error", async () => {
    await expect(
      createLocalEmbedder({
        pipelineFactory: async () => async () => ({ data: [1, 2, 3], dims: [] }),
      }),
    ).rejects.toThrow(/unexpected output shape/);
  });
});
