export interface MediaDownloadOptions {
  mediaId: string;
  accessToken: string;
  /** Default is the Cloud API's current stable version. */
  graphApiBaseUrl?: string;
  maxBytes: number;
  /** If omitted, any mime type is allowed. */
  allowedMimeTypes?: string[];
  fetchImpl?: typeof fetch;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export type MediaDownloadError =
  | { kind: "too_large"; limitBytes: number }
  | { kind: "mime_not_allowed"; mimeType: string }
  | { kind: "http_error"; status: number }
  | { kind: "network_error"; message: string };

export type MediaDownloadResult = { ok: true; media: DownloadedMedia } | { ok: false; error: MediaDownloadError };

/**
 * Cloud API media download is two hops: resolve mediaId -> {url, mime_type, file_size}, then GET
 * that temporary URL. Streams the body and aborts as soon as maxBytes is exceeded — file_size is
 * declared by Meta but not trusted as the sole guard (§10 "media too large -> validate; clear error").
 */
export async function downloadWhatsAppMedia(opts: MediaDownloadOptions): Promise<MediaDownloadResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const base = opts.graphApiBaseUrl ?? "https://graph.facebook.com/v21.0";
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  let metaRes: Response;
  try {
    metaRes = await fetchFn(`${base}/${opts.mediaId}`, { headers: auth });
  } catch (e) {
    return { ok: false, error: { kind: "network_error", message: (e as Error).message } };
  }
  if (!metaRes.ok) return { ok: false, error: { kind: "http_error", status: metaRes.status } };

  const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
  const mimeType = meta.mime_type ?? "application/octet-stream";
  if (opts.allowedMimeTypes && !opts.allowedMimeTypes.includes(mimeType)) {
    return { ok: false, error: { kind: "mime_not_allowed", mimeType } };
  }
  if (typeof meta.file_size === "number" && meta.file_size > opts.maxBytes) {
    return { ok: false, error: { kind: "too_large", limitBytes: opts.maxBytes } };
  }
  if (!meta.url) return { ok: false, error: { kind: "http_error", status: 502 } };

  let fileRes: Response;
  try {
    fileRes = await fetchFn(meta.url, { headers: auth });
  } catch (e) {
    return { ok: false, error: { kind: "network_error", message: (e as Error).message } };
  }
  if (!fileRes.ok) return { ok: false, error: { kind: "http_error", status: fileRes.status } };

  const reader = fileRes.body?.getReader();
  if (!reader) {
    // No stream to cap incrementally — reject on the declared Content-Length before buffering the
    // whole thing (still not fully trusted, same as file_size above, but avoids the common case of
    // allocating an oversized buffer just to reject it).
    const declaredLength = Number(fileRes.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
      return { ok: false, error: { kind: "too_large", limitBytes: opts.maxBytes } };
    }
    const buf = new Uint8Array(await fileRes.arrayBuffer());
    if (buf.byteLength > opts.maxBytes) return { ok: false, error: { kind: "too_large", limitBytes: opts.maxBytes } };
    return { ok: true, media: { bytes: buf, mimeType } };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel();
      return { ok: false, error: { kind: "too_large", limitBytes: opts.maxBytes } };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, media: { bytes, mimeType } };
}
