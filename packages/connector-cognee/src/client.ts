/**
 * A hand-rolled TypeScript REST client for Cognee's real API — no official Node.js/TypeScript SDK
 * exists (confirmed via real research: Cognee's primary SDK is Python; the REST API is the actual
 * integration surface for this ecosystem), so this follows the same pattern already proven in
 * `@wappy_ai/connector-google`'s `oauth.ts` (a plain `fetch`-based client, injectable `fetchImpl` for
 * testing, no SDK dependency).
 *
 * Every request/response shape here was confirmed against a REAL, locally-booted Cognee server
 * (v1.6.2) — its own live OpenAPI spec (`GET /openapi.json`) plus real `curl` round-trips (register →
 * login → create an API key → add → cognify → search → delete), not just read from docs. Concretely
 * confirmed, not assumed:
 * - `POST /api/v1/add` is `multipart/form-data`, fields `raw_data` (string) + `datasetName` — a JSON
 *   body is rejected.
 * - `POST /api/v1/cognify` is JSON `{ datasets: [name] }`.
 * - `POST /api/v1/search` is JSON `{ query, searchType, topK? }`. `searchType` matters a lot —
 *   the default (`HYBRID_COMPLETION`) returns an LLM-composed answer, not scored chunks; `"CHUNKS"`
 *   is what returns a flat array of `{ id, text, score, document_id, document_name, ... }` objects,
 *   which is the shape this client maps onto `Knowledge`'s `RecalledChunk`.
 * - Self-hosted auth (when enabled) uses `X-Api-Key: <key>`, NOT `Authorization: Bearer`.
 * - `DELETE /api/v1/datasets` (no path segment) deletes **every** dataset the caller can see,
 *   confirmed by a real call — there is no "delete by name in the body" variant. Deleting one
 *   dataset requires looking its id up by name via `GET /api/v1/datasets` first, then
 *   `DELETE /api/v1/datasets/{id}`.
 */

export type FetchImpl = typeof fetch;

export interface CogneeClientOptions {
  /** Your own Cognee instance — self-hosted (e.g. "http://localhost:8000") or Cognee Cloud. */
  baseUrl: string;
  /** Only needed for Cognee Cloud or an auth-enabled self-hosted instance. Sent as
   * `X-Api-Key: {apiKey}`; omitted entirely for an unauthenticated self-hosted instance. */
  apiKey?: string;
  fetchImpl?: FetchImpl;
}

export interface CogneeChunk {
  id?: string;
  text?: string;
  score?: number;
  document_id?: string;
  document_name?: string;
  [key: string]: unknown;
}

interface CogneeDataset {
  id: string;
  name: string;
}

function jsonHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey } : {};
}

async function parseJsonOrThrow(res: Response, action: string): Promise<unknown> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cognee API (${action}): non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const message = typeof json === "object" && json && "detail" in json ? String((json as { detail: unknown }).detail) : res.statusText;
    throw new Error(`Cognee API (${action}): ${message} (status ${res.status})`);
  }
  return json;
}

export interface CogneeClient {
  /** Ingests raw text into the dataset named `datasetName` (Cognee's own "dataset" concept — used
   * here as the equivalent of `Knowledge`'s `sourceId`). Data added this way isn't searchable until
   * `cognify()` runs on it. */
  add(datasetName: string, text: string): Promise<void>;
  /** Triggers Cognee's entity/relationship extraction pipeline over previously-`add`ed data for
   * `datasetName`. Must run after `add`, before that data is searchable via `search()`. */
  cognify(datasetName: string): Promise<void>;
  /** Semantic search across ingested data, using Cognee's "CHUNKS" search type so results come back
   * as scored passages rather than an LLM-composed answer. */
  search(query: string, topK?: number): Promise<CogneeChunk[]>;
  /** Removes the dataset named `datasetName` entirely. A no-op if no dataset with that name exists
   * (never falls back to Cognee's bare `DELETE /datasets`, which deletes everything). */
  removeDataset(datasetName: string): Promise<void>;
}

export function createCogneeClient(opts: CogneeClientOptions): CogneeClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function findDatasetId(name: string): Promise<string | null> {
    const res = await fetchImpl(`${base}/api/v1/datasets`, {
      method: "GET",
      headers: authHeaders(opts.apiKey),
    });
    const json = await parseJsonOrThrow(res, "findDatasetId");
    const datasets = Array.isArray(json) ? (json as CogneeDataset[]) : [];
    return datasets.find((d) => d.name === name)?.id ?? null;
  }

  return {
    async add(datasetName, text) {
      const form = new FormData();
      form.append("raw_data", text);
      form.append("datasetName", datasetName);
      const res = await fetchImpl(`${base}/api/v1/add`, {
        method: "POST",
        headers: authHeaders(opts.apiKey),
        body: form,
      });
      await parseJsonOrThrow(res, "add");
    },

    async cognify(datasetName) {
      const res = await fetchImpl(`${base}/api/v1/cognify`, {
        method: "POST",
        headers: jsonHeaders(opts.apiKey),
        body: JSON.stringify({ datasets: [datasetName], runInBackground: false }),
      });
      await parseJsonOrThrow(res, "cognify");
    },

    async search(query, topK) {
      const res = await fetchImpl(`${base}/api/v1/search`, {
        method: "POST",
        headers: jsonHeaders(opts.apiKey),
        body: JSON.stringify({ query, searchType: "CHUNKS", ...(topK !== undefined ? { topK } : {}) }),
      });
      const json = await parseJsonOrThrow(res, "search");
      // Confirmed live: a successful CHUNKS search returns a bare array of chunk objects. An empty/
      // no-data dataset throws a 4xx with a `detail` string instead (handled by parseJsonOrThrow's
      // !res.ok path above) — this defensive fallback is for any other, unanticipated shape.
      return Array.isArray(json) ? (json as CogneeChunk[]) : [];
    },

    async removeDataset(datasetName) {
      const id = await findDatasetId(datasetName);
      if (!id) return; // nothing to remove — never falls back to delete-everything
      const res = await fetchImpl(`${base}/api/v1/datasets/${id}`, {
        method: "DELETE",
        headers: authHeaders(opts.apiKey),
      });
      await parseJsonOrThrow(res, "removeDataset");
    },
  };
}
