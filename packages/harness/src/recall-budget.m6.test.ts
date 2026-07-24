import { describe, expect, test } from "vitest";
import type { Memory } from "@wappy/core";
import { recallWithBudget } from "./recall-budget.js";

function scriptedMemory(results: string[]): Memory {
  return {
    load: async () => [],
    append: async () => {},
    recall: async () => results,
  };
}

describe("recallWithBudget — snippet cap", () => {
  test("never returns more than maxSnippets, even if Memory.recall() returns more", async () => {
    const memory = scriptedMemory(["store hours are 9-5", "store location is 123 Main St", "return policy is 30 days"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "store", maxSnippets: 2 });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("fewer results than the cap are all returned", async () => {
    const memory = scriptedMemory(["store hours are 9-5"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "store hours", maxSnippets: 5 });
    expect(result).toEqual(["store hours are 9-5"]);
  });

  test("no results at all returns an empty array, not an error", async () => {
    const memory = scriptedMemory([]);
    expect(await recallWithBudget({ memory, contactId: "c1", query: "anything", maxSnippets: 5 })).toEqual([]);
  });
});

describe("recallWithBudget — relevance floor", () => {
  test("a snippet with no lexical overlap with the query is filtered out below the floor", async () => {
    const memory = scriptedMemory(["store hours are 9 to 5 daily", "completely unrelated text about weather"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "store hours", maxSnippets: 5, relevanceFloor: 0.3 });
    expect(result).toEqual(["store hours are 9 to 5 daily"]);
  });

  test("the most relevant snippets come first when the cap forces a choice", async () => {
    // "mentions store once" matches only 1 of the 2 query words; the other matches both.
    const memory = scriptedMemory(["mentions store once", "store hours are posted here"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "store hours", maxSnippets: 1 });
    expect(result).toEqual(["store hours are posted here"]);
  });

  test("with no relevanceFloor specified, nothing is filtered purely on relevance (default 0)", async () => {
    const memory = scriptedMemory(["totally unrelated content here"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "store hours", maxSnippets: 5 });
    expect(result).toEqual(["totally unrelated content here"]);
  });

  test("an empty query never matches anything above a positive floor (division-by-zero safe)", async () => {
    const memory = scriptedMemory(["some snippet"]);
    const result = await recallWithBudget({ memory, contactId: "c1", query: "", maxSnippets: 5, relevanceFloor: 0.1 });
    expect(result).toEqual([]);
  });
});
