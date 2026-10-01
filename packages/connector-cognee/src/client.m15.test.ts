import { describe, expect, test, vi } from "vitest";
import { createCogneeClient } from "./client.js";

/** M15 (plan: "Memory backend — local vs. Cognee"). Every request/response shape asserted here was
 * confirmed against a REAL, locally-booted Cognee server (v1.6.2) — its live OpenAPI spec plus real
 * curl round-trips (register, login, create an API key, add, cognify, search, delete) — not just
 * read from docs. See client.ts's own module doc comment for the full list of confirmed facts.
 * Tests still use an injected fake fetch (no real network in CI), but the shapes they assert on are
 * the real ones, not assumed ones. */

function fakeFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, statusText: "", text: async () => JSON.stringify(response) }) as unknown as Response);
}

describe("createCogneeClient — construction", () => {
  test("constructs fine with no fetchImpl given (defaults to the real global fetch, never invoked here)", () => {
    expect(() => createCogneeClient({ baseUrl: "http://localhost:8000" })).not.toThrow();
  });
});

describe("createCogneeClient — auth header", () => {
  test("sends X-Api-Key when an apiKey is configured — confirmed live: self-hosted auth rejects Authorization: Bearer for an API key, only X-Api-Key works", async () => {
    const fetchImpl = fakeFetch({ datasets: [], runInBackground: false });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", apiKey: "secret-key", fetchImpl });
    await client.cognify("ds1");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBe("secret-key");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBeUndefined();
  });

  test("omits the api-key header entirely when no apiKey is given (self-hosted, ENABLE_BACKEND_ACCESS_CONTROL=false)", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.cognify("ds1");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBeUndefined();
  });

  test("add() also sends X-Api-Key when configured (exercises the non-JSON authHeaders() path, not just jsonHeaders())", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", apiKey: "secret-key", fetchImpl });
    await client.add("ds1", "text");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers["x-api-key"]).toBe("secret-key");
  });
});

describe("createCogneeClient — add()", () => {
  test("POSTs multipart/form-data to /api/v1/add with raw_data + datasetName — confirmed live: a JSON body is rejected by the real server", async () => {
    const fetchImpl = fakeFetch({ status: "PipelineRunCompleted" });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.add("my-source", "some ingested text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/add");
    expect((init as { method: string }).method).toBe("POST");
    const body = (init as { body: FormData }).body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("raw_data")).toBe("some ingested text");
    expect(body.get("datasetName")).toBe("my-source");
  });

  test("a trailing slash on baseUrl is handled (no double slash in the request URL)", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000/", fetchImpl });
    await client.add("ds1", "text");
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/add");
  });
});

describe("createCogneeClient — cognify()", () => {
  test("POSTs JSON to /api/v1/cognify with datasets + runInBackground:false — confirmed live shape", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.cognify("my-source");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/cognify");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.datasets).toEqual(["my-source"]);
    expect(body.runInBackground).toBe(false);
  });
});

describe("createCogneeClient — search()", () => {
  test("POSTs query + searchType:CHUNKS to /api/v1/search, with topK when given — confirmed live: the default searchType returns an LLM answer, not scored chunks, so CHUNKS must be explicit", async () => {
    const fetchImpl = fakeFetch([]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.search("find invoices", 3);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/search");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.query).toBe("find invoices");
    expect(body.searchType).toBe("CHUNKS");
    expect(body.topK).toBe(3);
  });

  test("omits topK when not given", async () => {
    const fetchImpl = fakeFetch([]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.search("query");
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body).not.toHaveProperty("topK");
  });

  test("a single-user/no-auth CHUNKS response is a bare array of {id, text, score, document_id} — confirmed live with ENABLE_BACKEND_ACCESS_CONTROL=false", async () => {
    const fetchImpl = fakeFetch([{ id: "c1", text: "a matching chunk", score: 0.8, document_id: "doc-1", document_name: "text_abc" }]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([{ id: "c1", text: "a matching chunk", score: 0.8, document_id: "doc-1", document_name: "text_abc" }]);
  });

  test("a default auth-enabled/multi-tenant CHUNKS response wraps results per dataset — confirmed live: this is the shape anyone self-hosting WITHOUT setting ENABLE_BACKEND_ACCESS_CONTROL=false actually gets, and missing it silently dropped every real chunk", async () => {
    const fetchImpl = fakeFetch([
      { dataset_id: "ds-1", dataset_name: "ds-one", search_result: [{ id: "c1", text: "chunk from dataset one", score: 0.2 }] },
      { dataset_id: "ds-2", dataset_name: "ds-two", search_result: [{ id: "c2", text: "chunk from dataset two", score: 0.4 }] },
    ]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([
      { id: "c1", text: "chunk from dataset one", score: 0.2 },
      { id: "c2", text: "chunk from dataset two", score: 0.4 },
    ]);
  });

  test("a multi-tenant envelope with an empty search_result contributes nothing, not a crash", async () => {
    const fetchImpl = fakeFetch([{ dataset_id: "ds-1", dataset_name: "ds-one", search_result: [] }]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([]);
  });

  test("a multi-tenant envelope whose search_result isn't an array (unexpected) contributes nothing, not a crash", async () => {
    const fetchImpl = fakeFetch([
      { dataset_id: "ds-1", dataset_name: "ds-one", search_result: "not-an-array" },
      { dataset_id: "ds-2", dataset_name: "ds-two", search_result: [{ id: "c2", text: "real chunk", score: 0.3 }] },
    ]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([{ id: "c2", text: "real chunk", score: 0.3 }]);
  });

  test("an unrecognized response shape degrades to an empty result, not a crash", async () => {
    const fetchImpl = fakeFetch({ somethingUnexpected: true });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([]);
  });
});

describe("createCogneeClient — removeDataset()", () => {
  test("looks up the dataset's id by name via GET /datasets, then DELETEs /datasets/{id} — confirmed live: the bare DELETE /datasets endpoint deletes every dataset, not just one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "", text: async () => JSON.stringify([{ id: "uuid-1", name: "my-source" }, { id: "uuid-2", name: "other" }]) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "", text: async () => "{}" } as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.removeDataset("my-source");
    expect(fetchImpl.mock.calls).toHaveLength(2);
    const [listUrl, listInit] = fetchImpl.mock.calls[0]!;
    expect(String(listUrl)).toBe("http://localhost:8000/api/v1/datasets");
    expect((listInit as { method: string }).method).toBe("GET");
    const [delUrl, delInit] = fetchImpl.mock.calls[1]!;
    expect(String(delUrl)).toBe("http://localhost:8000/api/v1/datasets/uuid-1");
    expect((delInit as { method: string }).method).toBe("DELETE");
  });

  test("a dataset name with no match is a no-op — never falls back to the delete-everything bare endpoint", async () => {
    const fetchImpl = fakeFetch([{ id: "uuid-2", name: "other" }]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.removeDataset("missing-dataset");
    expect(fetchImpl.mock.calls).toHaveLength(1); // only the GET /datasets lookup, no DELETE call
  });

  test("a non-array GET /datasets response is treated defensively as no datasets, not a crash", async () => {
    const fetchImpl = fakeFetch({ unexpected: "shape" });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.removeDataset("anything");
    expect(fetchImpl.mock.calls).toHaveLength(1); // lookup only, no DELETE call attempted
  });
});

describe("createCogneeClient — error handling", () => {
  test("a non-ok response throws with the server's own error detail, not a generic message", async () => {
    const fetchImpl = fakeFetch({ detail: "dataset not found" }, false, 404);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.cognify("missing")).rejects.toThrow(/dataset not found/);
  });

  test("a non-ok response with no 'detail' field falls back to the HTTP status text", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "{}" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.cognify("x")).rejects.toThrow(/Internal Server Error/);
  });

  test("a non-JSON response is reported honestly, not silently parsed as empty", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: "", text: async () => "<html>not json</html>" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.cognify("ds1")).rejects.toThrow(/non-JSON response/);
  });

  test("an empty response body parses as an empty object, not a crash", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: "", text: async () => "" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.cognify("ds1")).resolves.toBeUndefined();
  });
});
