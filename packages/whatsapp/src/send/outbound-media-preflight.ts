import type { SmartMessage } from "@wappy/core";
import { OUTBOUND_MEDIA_LIMITS, type OutboundMediaError, type OutboundMediaKind } from "./outbound-media.js";

export interface PreflightOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Best-effort outbound media validation before send (§10 "media too large / bad mime -> validate;
 * clear error"). Meta fetches the media URL itself — we don't have the bytes — so: mime is checked
 * immediately when the model supplied one; size is checked via a HEAD request's Content-Length
 * when the server provides one. A HEAD failure or a missing/unparseable header is NOT an error:
 * this is a best-effort pre-check, and Meta's own validation is the backstop (same tradeoff as the
 * inbound media downloader, M3's media.ts).
 */
export async function preflightOutboundMedia(media: NonNullable<SmartMessage["media"]>, opts: PreflightOptions = {}): Promise<OutboundMediaError | undefined> {
  const limit = OUTBOUND_MEDIA_LIMITS[media.kind as OutboundMediaKind];
  if (!limit) return { kind: "unknown_kind", mediaKind: media.kind };

  if (media.mimeType && limit.mimeTypes.length > 0 && !limit.mimeTypes.includes(media.mimeType)) {
    return { kind: "mime_not_allowed", mimeType: media.mimeType, allowed: limit.mimeTypes };
  }
  if (!media.url) return undefined;

  const fetchFn = opts.fetchImpl ?? fetch;
  let contentLength: number | undefined;
  try {
    const res = await fetchFn(media.url, { method: "HEAD" });
    const header = res.headers.get("content-length");
    contentLength = header ? Number(header) : undefined;
  } catch {
    return undefined;
  }

  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > limit.maxBytes) {
    return { kind: "too_large", limitBytes: limit.maxBytes };
  }
  return undefined;
}
