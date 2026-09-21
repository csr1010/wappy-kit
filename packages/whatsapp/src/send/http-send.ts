import type { Clock } from "@wappy/core";
import { computeBackoffMs, parseRetryAfterMs, type BackoffOptions } from "./backoff.js";
import { mapMetaErrorCode } from "./error-map.js";
import type { CloudApiOutboundPayload } from "./render.js";

export interface HttpSendDeps {
  graphApiBaseUrl: string;
  phoneNumberId: string;
  accessToken: string;
  fetchImpl: typeof fetch;
  clock: Pick<Clock, "now" | "sleep">;
  maxAttempts?: number;
  backoff?: BackoffOptions;
}

export type HttpSendResult = { ok: true; messageId?: string } | { ok: false; reason: string; metaCode?: number; httpStatus?: number };

/** POSTs a Cloud API payload, retrying (with backoff, honoring Retry-After) whenever mapMetaErrorCode says "retry" (§6.2, §6.6). */
export async function sendWithRetry(payload: CloudApiOutboundPayload, deps: HttpSendDeps): Promise<HttpSendResult> {
  const maxAttempts = deps.maxAttempts ?? 3;
  let lastResult: HttpSendResult = { ok: false, reason: "send was never attempted" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchImpl(`${deps.graphApiBaseUrl}/${deps.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.accessToken}` },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      lastResult = { ok: false, reason: `network error: ${(e as Error).message}` };
      if (attempt < maxAttempts) await deps.clock.sleep(computeBackoffMs(attempt, deps.backoff));
      continue;
    }

    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const messageId = (body as { messages?: { id?: string }[] } | undefined)?.messages?.[0]?.id;
      return { ok: true, messageId };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const err = (body as { error?: { code?: number; message?: string } } | undefined)?.error;
    lastResult = { ok: false, reason: err ? `meta ${err.code}: ${err.message}` : `http ${res.status}`, metaCode: err?.code, httpStatus: res.status };

    const action = mapMetaErrorCode(err?.code, res.status);
    if (action !== "retry" || attempt === maxAttempts) return lastResult;

    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), deps.clock.now());
    await deps.clock.sleep(retryAfterMs ?? computeBackoffMs(attempt, deps.backoff));
  }
  return lastResult;
}
