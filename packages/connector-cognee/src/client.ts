/**
 * A hand-rolled TypeScript REST client for Cognee's real API — no official Node.js/TypeScript SDK
 * exists (confirmed via real research: Cognee's primary SDK is Python; the REST API is the actual
 * integration surface for this ecosystem), so this follows the same pattern already proven in
 * `@wappy_ai/connector-google`'s `oauth.ts` (a plain `fetch`-based client, injectable `fetchImpl` for
 * testing, no SDK dependency).
 *
 * Endpoints (confirmed real, under the `/api/v1/` prefix — see https://api.cognee.ai/docs for the
 * full Swagger reference): `POST /api/v1/add` (ingest raw text), `POST /api/v1/cognify` (triggers
 * the entity/relationship extraction pipeline on previously-added data — must run after `add`,
 * before that data is searchable), `POST /api/v1/search` (semantic query), `DELETE /api/v1/datasets`
 * (remove a dataset).
 *
 * HONEST, STATED UNKNOWN (per the plan this was built from): the exact request/response JSON body
 * shapes for these four endpoints were not independently confirmed against a live Cognee instance —
 * only the endpoint paths, methods, and general purpose were verified via Cognee's own published
 * docs. The shapes below are this implementation's best-effort construction from that documentation;
 * verify against https://api.cognee.ai/docs (interactive Swagger) against a real instance before
 * trusting this in production, and adjust if the real server disagrees.
 */

export type FetchImpl = typeof fetch;

export interface CogneeClientOptions {
  /** Your own Cognee instance — self-hosted (e.g. "http://localhost:8000") or Cognee Cloud. */
  baseUrl: string;
  /** Only needed for Cognee Cloud or an auth-enabled self-hosted instance. Sent as
   * `Authorization: Bearer {apiKey}`; omitted entirely for an unauthenticated self-hosted instance. */
  apiKey?: string;
  fetchImpl?: FetchImpl;
}

export interface CogneeSearchResult {
  id?: string;
  text?: string;
  score?: number;
  /** Cognee's real response may nest additional graph/entity metadata beyond what this client reads
   * — kept as an open record rather than a narrow type, since the exact full shape isn't confirmed
   * (see the module-level honest-unknown note above). */
  [key: string]: unknown;
}

function headers(apiKey: string | undefined, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
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
  /** Ingests raw text under `datasetId` (Cognee's own "dataset" concept — used here as the
   * equivalent of `Knowledge`'s `sourceId`). Data added this way isn't searchable until `cognify()`
   * runs on it. */
  add(datasetId: string, text: string): Promise<void>;
  /** Triggers Cognee's entity/relationship extraction pipeline over previously-`add`ed data for
   * `datasetId`. Must run after `add`, before that data is searchable via `search()`. */
  cognify(datasetId: string): Promise<void>;
  /** Semantic search across ingested data. */
  search(query: string, topK?: number): Promise<CogneeSearchResult[]>;
  /** Removes a dataset entirely. */
  removeDataset(datasetId: string): Promise<void>;
}

export function createCogneeClient(opts: CogneeClientOptions): CogneeClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async add(datasetId, text) {
      const res = await fetchImpl(`${base}/api/v1/add`, {
        method: "POST",
        headers: headers(opts.apiKey),
        body: JSON.stringify({ data: text, datasetName: datasetId }),
      });
      await parseJsonOrThrow(res, "add");
    },

    async cognify(datasetId) {
      const res = await fetchImpl(`${base}/api/v1/cognify`, {
        method: "POST",
        headers: headers(opts.apiKey),
        body: JSON.stringify({ datasets: [datasetId] }),
      });
      await parseJsonOrThrow(res, "cognify");
    },

    async search(query, topK) {
      const res = await fetchImpl(`${base}/api/v1/search`, {
        method: "POST",
        headers: headers(opts.apiKey),
        body: JSON.stringify({ query, ...(topK !== undefined ? { topK } : {}) }),
      });
      const json = await parseJsonOrThrow(res, "search");
      // Cognee's real response shape isn't independently confirmed (see module-level note) — this
      // defensively accepts either a bare array or a `{ results: [...] }` envelope, the two most
      // common REST conventions, rather than assuming one specific shape.
      if (Array.isArray(json)) return json as CogneeSearchResult[];
      if (json && typeof json === "object" && "results" in json && Array.isArray((json as { results: unknown }).results)) {
        return (json as { results: CogneeSearchResult[] }).results;
      }
      return [];
    },

    async removeDataset(datasetId) {
      const res = await fetchImpl(`${base}/api/v1/datasets`, {
        method: "DELETE",
        headers: headers(opts.apiKey),
        body: JSON.stringify({ datasetName: datasetId }),
      });
      await parseJsonOrThrow(res, "removeDataset");
    },
  };
}
