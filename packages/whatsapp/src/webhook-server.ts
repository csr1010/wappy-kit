import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Agent, MessageChannel } from "@wappy/core";
import { handleVerifyHandshake } from "./verify-handshake.js";
import { verifySignature } from "./signature.js";
import type { WhatsAppMessageChannel } from "./channel.js";

/**
 * T9.7's server: the actual `http.Server` a generated project's `wappy dev` boots. Deliberately
 * Node's built-in `http`, not Express — the entire surface is one route (GET handshake, POST
 * webhook) plus raw-body reading for signature verification, which doesn't earn a framework
 * dependency (§1.2 "wrap, don't reinvent" is for genuine gaps; this isn't one). Lives in
 * `@wappy/whatsapp` because handling Meta's exact webhook protocol (handshake query params,
 * `X-Hub-Signature-256`, raw-body requirement) is this channel's own concern — it only takes an
 * `Agent` (an @wappy/core interface, not @wappy/harness), so hub-and-spoke holds: this package
 * still imports nothing from harness.
 *
 * Design: respond 200 as soon as the request is structurally valid (parsed + signature-verified),
 * THEN process messages — matches WhatsApp's own guidance (ack fast, Meta retries on timeout) and
 * relies on `channel.receive()`'s own dedupe (seenStore) to make a retried delivery a no-op rather
 * than a double-reply. A caller that wants to know about processing failures (not delivery
 * failures — `Agent.handle()` never throws, see harness's `handleSafely`) passes `onError`.
 */
export interface CreateWebhookServerOptions {
  /** The same token given to Meta when configuring the webhook (GET handshake). */
  verifyToken: string;
  /** The Meta app secret — verifies `X-Hub-Signature-256` on every POST. Required: an unverified
   * webhook accepts forged requests (§6.2, §11 "signature verification mandatory"). */
  appSecret: string;
  channel: MessageChannel;
  agent: Agent;
  /** Path the webhook is served at. Default "/webhook" (matches the generated README). */
  path?: string;
  /** Reports an error from reading/parsing a request, OR an unexpected throw from
   * `channel.receive`/`agent.handle` (both are already supposed to be exception-safe — this is a
   * last-resort net, not the normal error path). Never throws itself. */
  onError?: (error: unknown) => void;
  /** Refuses a POST body larger than this many bytes (413) rather than buffering it unbounded.
   * Meta's payloads are small JSON. Default 5MB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<{ ok: true; body: string } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      body += chunk.toString("utf8");
      if (body.length > maxBodyBytes) {
        tooLarge = true;
        resolve({ ok: false, status: 413 });
      }
    });
    req.on("end", () => {
      if (!tooLarge) resolve({ ok: true, body });
    });
    req.on("error", () => resolve({ ok: false, status: 400 }));
  });
}

function send(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

export function createWebhookServer(opts: CreateWebhookServerOptions): Server {
  const path = opts.path ?? "/webhook";
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer((req, res) => {
    void (async () => {
      // req.url is typed string | undefined only because IncomingMessage is shared with the
      // client-request case; for a real server "request" event it's always set (Node's own docs).
      const url = new URL(req.url as string, "http://localhost");
      if (url.pathname !== path) {
        send(res, 404);
        return;
      }

      if (req.method === "GET") {
        // Meta's one-time verification handshake — query params, not headers.
        const result = handleVerifyHandshake(
          { "hub.mode": url.searchParams.get("hub.mode") ?? undefined, "hub.verify_token": url.searchParams.get("hub.verify_token") ?? undefined, "hub.challenge": url.searchParams.get("hub.challenge") ?? undefined },
          opts.verifyToken,
        );
        if (result.ok) send(res, 200, result.challenge);
        else send(res, 403);
        return;
      }

      if (req.method !== "POST") {
        send(res, 405);
        return;
      }

      const read = await readBody(req, maxBodyBytes);
      if (!read.ok) {
        send(res, read.status);
        return;
      }

      // Signature checked over the RAW body, before any JSON.parse — parsing first (even just to
      // validate shape) would let a forged request past this check by construction.
      if (!verifySignature(read.body, req.headers["x-hub-signature-256"] as string | undefined, opts.appSecret)) {
        send(res, 401);
        return;
      }

      let payload: unknown;
      try {
        payload = read.body.length > 0 ? JSON.parse(read.body) : {};
      } catch (e) {
        opts.onError?.(e);
        send(res, 400);
        return;
      }

      // Ack now — `channel.receive`'s own dedupe makes a Meta retry of this exact delivery a no-op,
      // so there's no correctness reason to make Meta wait for the agent to finish replying.
      send(res, 200);

      try {
        const messages = await opts.channel.receive(payload);
        for (const message of messages) {
          // Fired before/alongside agent.handle(), not awaited — it's the user-visible "..." while
          // the slower model/tool work runs, so it must go out as early as possible, and Meta
          // auto-dismisses it on its own (25s, or when the real reply lands) so there's nothing to
          // clean up here even if agent.handle() is slow or fails. WhatsAppMessageChannel-specific
          // (checked via the property, not the `MessageChannel` core type) — a channel without it
          // just skips this, same as any channel implementation that isn't WhatsApp.
          if (typeof (opts.channel as Partial<WhatsAppMessageChannel>).markReadAndTyping === "function") {
            void (opts.channel as WhatsAppMessageChannel).markReadAndTyping(message.id).then((r) => {
              if (!r.ok) opts.onError?.(new Error(`markReadAndTyping: ${r.error}`));
            });
          }
          void opts.agent.handle(message).catch((e: unknown) => opts.onError?.(e));
        }
      } catch (e) {
        opts.onError?.(e);
      }
    })();
  });
}
