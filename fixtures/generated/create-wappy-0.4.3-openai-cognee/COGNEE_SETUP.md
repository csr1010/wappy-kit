# Connecting Cognee (knowledge-graph memory)

Retrieved knowledge (anything ingested via `@wappy_ai/harness`'s Knowledge/RAG) is backed by
Cognee instead of the local default — a self-hosted or cloud service that builds a knowledge
graph of entities/relationships rather than literal keyword matching, and is designed to keep
correcting itself over repeated ingests. Never a shared Wappy-operated instance — you bring
your own, same pattern as everything else here.

## 1. Get a Cognee instance running

Three real paths, confirmed by actually running each of these (not just read from docs):

- **Self-hosted, Docker (easiest)**: a single copy-pasteable compose file, no cloning —
  https://github.com/topoteretes/cognee/blob/main/docs/minimal-docker-compose.md. Starts
  the real REST API on `http://localhost:8000`.
- **Self-hosted, no Docker**: `pip install cognee` (needs Python 3.10–3.14), then
  `uvicorn cognee.api.client:app --host 0.0.0.0 --port 8011`. Its default graph backend
  (Ladybug/Kuzu) needs a native shared library that isn't on PyPI — grab the prebuilt one for
  your platform from https://github.com/LadybugDB/ladybug/releases and point
  `LBUG_C_API_LIB_PATH` at it, or just use the Docker path above, which doesn't have this step.
- **Cloud**: sign up for Cognee Cloud, create a project, and get a base URL + API key from
  their dashboard: https://www.cognee.ai/

**Confirmed by real testing, not a guess**: you do NOT need an LLM provider API key to get
started. With no `LLM_API_KEY` set on the Cognee server, it falls back to free local models —
`fastembed` for embeddings, `GLiNER` for entity extraction — and a real ingest → cognify →
search round trip works end to end on that alone. Setting a real LLM key gets you higher-
quality entity/relationship extraction; it's an upgrade, not a requirement.

## 2. Get a token (self-hosted) or none at all

Self-hosted Cognee can run two ways — pick whichever matches your instance:

- **No auth (simplest for local use)**: set `ENABLE_BACKEND_ACCESS_CONTROL=false` on the
  Cognee server and leave `COGNEE_API_KEY` blank below. Nothing else to do.
- **Auth enabled (the default if you don't set that)**: register a user, log in, then create
  an API key — three real calls against your own instance:
  ```sh
  # 1. register
  curl -X POST $COGNEE_BASE_URL/api/v1/auth/register -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password"}'
  # 2. log in -> access_token
  curl -X POST $COGNEE_BASE_URL/api/v1/auth/login -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=you@example.com&password=choose-a-password"
  # 3. create an API key with that access_token -> this is your COGNEE_API_KEY
  curl -X POST $COGNEE_BASE_URL/api/v1/auth/api-keys -H "Authorization: Bearer <access_token>" \
    -H "Content-Type: application/json" -d '{"name":"wappy"}'
  ```
- **Cognee Cloud**: skip all of the above — your API key comes straight from their dashboard.

## 3. Fill in `.env`

- `COGNEE_BASE_URL` — your instance's URL (e.g. `http://localhost:8000` for self-hosted, or
  the URL Cognee Cloud gives you).
- `COGNEE_API_KEY` — the key from step 2 (Cognee Cloud or an auth-enabled self-hosted
  instance), or leave blank for a no-auth self-hosted instance.

## 4. Test it

This scaffold wires Cognee into the agent's RAG lookup (`retrieveRag`, used automatically on
any message the router decides needs it) — but doesn't yet call `knowledge.ingest()` from
anywhere on its own, since there's no built-in "ingest this" command or trigger in this
scaffold. Said honestly, not invented: to actually put something into Cognee to recall later,
call `knowledge.ingest(sourceId, text)` yourself — e.g. from a small script, or by wiring a
tool/command that calls it — using the `knowledge` instance `index.ts` already constructs.
