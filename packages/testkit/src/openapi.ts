import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body: string;
}
export type Fixture = { status?: number; body?: unknown } | ((req: FakeRequest) => unknown);

/** Serves `spec` at /openapi.json and answers "METHOD /path/{param}" routes from `fixtures`. Unknown route = 404. */
export async function mockOpenApiServer(spec: unknown, fixtures: Record<string, Fixture> = {}) {
  const requests: Array<{ method: string; path: string }> = [];
  const routes = Object.entries(fixtures).map(([key, fx]) => {
    const [method, template] = key.split(" ") as [string, string];
    const names: string[] = [];
    const re = new RegExp("^" + template.replace(/\{(\w+)\}/g, (_, nm) => (names.push(nm), "([^/]+)")) + "$");
    return { method: method.toUpperCase(), re, names, fx };
  });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0]!;
      requests.push({ method, path });
      const send = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (method === "GET" && path === "/openapi.json") return send(200, spec);
      for (const r of routes) {
        const m = r.method === method ? r.re.exec(path) : null;
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((nm, i) => [nm, decodeURIComponent(m[i + 1]!)]));
        if (typeof r.fx === "function") return send(200, r.fx({ method, path, params, body }));
        return send(r.fx.status ?? 200, r.fx.body ?? {});
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
