/**
 * @wappy/testkit (private) — public API. Do not open the internals; use these:
 *   tmpProject() -> {dir, home, path(rel), write(rel, s), cleanup()}   HOME is isolated; call cleanupAllTmpProjects() in afterEach
 *   fakeClock(start?) -> {now, setTimeout, clearTimeout, sleep, advance(ms)}
 *   signWebhook(body, secret) -> "sha256=<hex>" for X-Hub-Signature-256
 *   await mockWhatsAppCloud({webhookUrl?, appSecret?}) -> {url, sent[], failNext(n,{code,status?}), rateLimitNext(n),
 *                                                          serverErrorNext(n), emitStatus(id, sent|delivered|read|failed), close()}
 *   mockModel(steps) -> {calls[], generate({prompt})}; steps: {text}|{structured}|{toolCalls}|{error}|{contextLengthError:true}
 *   await mockOpenApiServer(spec, {"GET /x/{id}": fixture|fn}) -> {url, requests[], close()}; spec served at /openapi.json
 */
export * from "./helpers.js";
export * from "./whatsapp.js";
export * from "./model.js";
export * from "./openapi.js";
