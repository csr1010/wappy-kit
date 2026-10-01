import { describe, expect, test, vi } from "vitest";
import { createCogneeClient } from "./client.js";

/** M15 (plan: "Memory backend — local vs. Cognee"). Injected fake fetch, no real network, ever —
 * the real request/response JSON shapes aren't independently confirmed against a live Cognee
 * instance (see client.ts's own honest-unknown note), so these tests assert on the request shape
 * this implementation sends and on how it handles a few plausible response shapes, not on "the real
 * Cognee API definitely behaves this way." */

function fakeFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, statusText: "", text: async () => JSON.stringify(response) }) as unknown as Response);
}

describe("createCogneeClient — construction", () => {
  test("constructs fine with no fetchImpl given (defaults to the real global fetch, never invoked here)", () => {
    expect(() => createCogneeClient({ baseUrl: "http://localhost:8000" })).not.toThrow();
  });
});

describe("createCogneeClient — auth header", () => {
  test("sends Authorization: Bearer <apiKey> when an apiKey is configured", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", apiKey: "secret-key", fetchImpl });
    await client.add("ds1", "hello world");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer secret-key");
  });

  test("omits the Authorization header entirely when no apiKey is given (self-hosted, no auth)", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.add("ds1", "hello world");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers.authorization).toBeUndefined();
  });
});

describe("createCogneeClient — add/cognify/removeDataset request shape", () => {
  test("add() POSTs to /api/v1/add with the text and dataset id", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.add("my-source", "some ingested text");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/add");
    expect((init as { method: string }).method).toBe("POST");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.data).toBe("some ingested text");
    expect(body.datasetName).toBe("my-source");
  });

  test("cognify() POSTs to /api/v1/cognify with the dataset id", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.cognify("my-source");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/cognify");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.datasets).toEqual(["my-source"]);
  });

  test("removeDataset() sends DELETE to /api/v1/datasets", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.removeDataset("my-source");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/datasets");
    expect((init as { method: string }).method).toBe("DELETE");
  });

  test("a trailing slash on baseUrl is handled (no double slash in the request URL)", async () => {
    const fetchImpl = fakeFetch({});
    const client = createCogneeClient({ baseUrl: "http://localhost:8000/", fetchImpl });
    await client.add("ds1", "text");
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/add");
  });
});

describe("createCogneeClient — search()", () => {
  test("POSTs the query to /api/v1/search, with topK when given", async () => {
    const fetchImpl = fakeFetch([]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await client.search("find invoices", 3);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8000/api/v1/search");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.query).toBe("find invoices");
    expect(body.topK).toBe(3);
  });

  test("accepts a bare array response", async () => {
    const fetchImpl = fakeFetch([{ id: "1", text: "a match", score: 0.9 }]);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([{ id: "1", text: "a match", score: 0.9 }]);
  });

  test("accepts a { results: [...] } envelope response", async () => {
    const fetchImpl = fakeFetch({ results: [{ id: "1", text: "a match", score: 0.9 }] });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([{ id: "1", text: "a match", score: 0.9 }]);
  });

  test("an unrecognized response shape degrades to an empty result, not a crash", async () => {
    const fetchImpl = fakeFetch({ somethingUnexpected: true });
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    const results = await client.search("query");
    expect(results).toEqual([]);
  });
});

describe("createCogneeClient — error handling", () => {
  test("a non-ok response throws with the server's own error detail, not a generic message", async () => {
    const fetchImpl = fakeFetch({ detail: "dataset not found" }, false, 404);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.removeDataset("missing")).rejects.toThrow(/dataset not found/);
  });

  test("a non-ok response with no 'detail' field falls back to the HTTP status text", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "{}" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.removeDataset("x")).rejects.toThrow(/Internal Server Error/);
  });

  test("a non-JSON response is reported honestly, not silently parsed as empty", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: "", text: async () => "<html>not json</html>" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.add("ds1", "text")).rejects.toThrow(/non-JSON response/);
  });

  test("an empty response body parses as an empty object, not a crash", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: "", text: async () => "" }) as unknown as Response);
    const client = createCogneeClient({ baseUrl: "http://localhost:8000", fetchImpl });
    await expect(client.add("ds1", "text")).resolves.toBeUndefined();
  });
});
