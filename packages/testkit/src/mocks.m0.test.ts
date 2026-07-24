import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mockWhatsAppCloud, mockModel, mockOpenApiServer, signWebhook } from "./index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const send = (url: string, body: unknown) =>
  fetch(`${url}/v20.0/123/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mockWhatsAppCloud", () => {
  test("records sends and returns a message id", async () => {
    const wa = await mockWhatsAppCloud();
    closers.push(wa.close);
    const r = await send(wa.url, { to: "1", type: "text", text: { body: "yo" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).messages[0].id).toMatch(/^wamid\./);
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.body).toMatchObject({ to: "1" });
  });
  test("scripted failures: code N times, then 429, 5xx, then success", async () => {
    const wa = await mockWhatsAppCloud();
    closers.push(wa.close);
    wa.failNext(2, { code: 131047 });
    wa.rateLimitNext(1);
    wa.serverErrorNext(1);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await send(wa.url, { i })).status);
    expect(statuses).toEqual([400, 400, 429, 500, 200]);
    wa.failNext(1, { code: 131026 });
    const r = (await (await send(wa.url, {})).json()) as any;
    expect(r.error.code).toBe(131026);
    expect(wa.sent).toHaveLength(6); // failed attempts are recorded too
  });
  test("emits signed status webhooks to a target", async () => {
    const got: Array<{ sig: string | undefined; body: string }> = [];
    const srv: Server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        got.push({ sig: req.headers["x-hub-signature-256"] as string | undefined, body: b });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => srv.close(() => r())));
    const port = (srv.address() as { port: number }).port;
    const wa = await mockWhatsAppCloud({ webhookUrl: `http://127.0.0.1:${port}/hook`, appSecret: "sek" });
    closers.push(wa.close);
    for (const s of ["sent", "delivered", "read", "failed"] as const) await wa.emitStatus("wamid.1", s);
    expect(got).toHaveLength(4);
    expect(got[0]!.sig).toBe(signWebhook(got[0]!.body, "sek"));
    expect(JSON.parse(got[3]!.body).entry[0].changes[0].value.statuses[0].status).toBe("failed");
  });
  test("close stops the server", async () => {
    const wa = await mockWhatsAppCloud();
    await wa.close();
    await expect(send(wa.url, {})).rejects.toBeTruthy();
  });
});

describe("mockModel", () => {
  test("plays script in order and records every call", async () => {
    const m = mockModel([
      { text: "hello" },
      { structured: { a: 1 } },
      { toolCalls: [{ name: "lookup", args: { id: 7 } }] },
      { error: new Error("boom") },
      { contextLengthError: true },
    ]);
    expect(await m.generate({ prompt: "p1" })).toMatchObject({ text: "hello" });
    expect(await m.generate({ prompt: "p2" })).toMatchObject({ structured: { a: 1 } });
    expect((await m.generate({ prompt: "p3" })).toolCalls?.[0]).toMatchObject({ name: "lookup" });
    await expect(m.generate({ prompt: "p4" })).rejects.toThrow("boom");
    await expect(m.generate({ prompt: "p5" })).rejects.toMatchObject({ code: "context_length_exceeded" });
    expect(m.calls.map((c) => c.prompt)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });
  test("running out of script fails loudly", async () => {
    const m = mockModel([]);
    await expect(m.generate({ prompt: "x" })).rejects.toThrow(/script exhausted/);
  });
});

describe("mockOpenApiServer", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: { "/pets/{id}": { get: { operationId: "getPet" } }, "/pets": { post: { operationId: "addPet" } } },
  };
  test("serves the spec and implements endpoints from fixtures", async () => {
    const s = await mockOpenApiServer(spec, {
      "GET /pets/{id}": (req) => ({ id: req.params.id }),
      "POST /pets": { status: 201, body: { ok: true } },
    });
    closers.push(s.close);
    expect(await (await fetch(`${s.url}/openapi.json`)).json()).toEqual(spec);
    expect(await (await fetch(`${s.url}/pets/42`)).json()).toEqual({ id: "42" });
    const r = await fetch(`${s.url}/pets`, { method: "POST", body: "{}" });
    expect(r.status).toBe(201);
    expect((await fetch(`${s.url}/nope`)).status).toBe(404);
    expect(s.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /openapi.json", "GET /pets/42", "POST /pets", "GET /nope"]);
  });
});
