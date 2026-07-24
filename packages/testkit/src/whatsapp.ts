import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signWebhook } from "./helpers.js";

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";
export interface RecordedSend {
  path: string;
  body: unknown;
  status: number;
}

export interface MockWhatsAppOptions {
  /** Where emitStatus() POSTs status webhooks. */
  webhookUrl?: string;
  appSecret?: string;
}

/** Local fake of the WhatsApp Cloud API `/messages` endpoint. Script failures with the *Next helpers (FIFO). */
export async function mockWhatsAppCloud(opts: MockWhatsAppOptions = {}) {
  const sent: RecordedSend[] = [];
  const queue: Array<{ status: number; error: { code: number; message: string } }> = [];
  let n = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw string */
      }
      const scripted = queue.shift();
      const status = scripted?.status ?? 200;
      sent.push({ path: req.url ?? "", body, status });
      res.setHeader("content-type", "application/json");
      res.statusCode = status;
      res.end(JSON.stringify(scripted ? { error: scripted.error } : { messaging_product: "whatsapp", messages: [{ id: `wamid.${++n}` }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const push = (times: number, status: number, code: number, message: string) => {
    for (let i = 0; i < times; i++) queue.push({ status, error: { code, message } });
  };

  return {
    url,
    sent,
    failNext: (times: number, o: { code: number; status?: number; message?: string }) => push(times, o.status ?? 400, o.code, o.message ?? "scripted failure"),
    rateLimitNext: (times: number) => push(times, 429, 130429, "rate limit hit"),
    serverErrorNext: (times: number) => push(times, 500, 1, "internal error"),
    async emitStatus(messageId: string, status: DeliveryStatus): Promise<void> {
      if (!opts.webhookUrl) throw new Error("mockWhatsAppCloud: webhookUrl not configured");
      const payload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "waba", changes: [{ field: "messages", value: { statuses: [{ id: messageId, status, timestamp: "0" }] } }] }],
      });
      await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook(payload, opts.appSecret ?? "") },
        body: payload,
      });
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
