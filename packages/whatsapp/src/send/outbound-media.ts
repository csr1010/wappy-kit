export type OutboundMediaKind = "image" | "document" | "video" | "audio" | "voice";

export interface OutboundMediaLimit {
  maxBytes: number;
  /** Empty = no allow-list restriction beyond what Meta itself enforces. */
  mimeTypes: string[];
}

// developers.facebook.com/docs/whatsapp/cloud-api/reference/media — verify against that page.
export const OUTBOUND_MEDIA_LIMITS: Record<OutboundMediaKind, OutboundMediaLimit> = {
  image: { maxBytes: 5 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  video: { maxBytes: 16 * 1024 * 1024, mimeTypes: ["video/mp4", "video/3gpp"] },
  audio: { maxBytes: 16 * 1024 * 1024, mimeTypes: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"] },
  voice: { maxBytes: 16 * 1024 * 1024, mimeTypes: ["audio/ogg", "audio/aac", "audio/mp4"] },
  document: { maxBytes: 100 * 1024 * 1024, mimeTypes: [] },
};

export type OutboundMediaError =
  | { kind: "unknown_kind"; mediaKind: string }
  | { kind: "too_large"; limitBytes: number }
  | { kind: "mime_not_allowed"; mimeType: string; allowed: string[] };

/** Pre-send validation for outbound media (§10 "media too large / bad mime -> validate; clear error"). undefined = ok. */
export function validateOutboundMedia(mediaKind: string, sizeBytes: number, mimeType: string): OutboundMediaError | undefined {
  const limit = OUTBOUND_MEDIA_LIMITS[mediaKind as OutboundMediaKind];
  if (!limit) return { kind: "unknown_kind", mediaKind };
  if (sizeBytes > limit.maxBytes) return { kind: "too_large", limitBytes: limit.maxBytes };
  if (limit.mimeTypes.length > 0 && !limit.mimeTypes.includes(mimeType)) return { kind: "mime_not_allowed", mimeType, allowed: limit.mimeTypes };
  return undefined;
}
