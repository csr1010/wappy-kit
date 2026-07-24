import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * X-Hub-Signature-256 verification (§6.2, §11). Must run against the RAW request body bytes —
 * parsing JSON first and re-serializing would produce a different byte sequence and always fail.
 */
export function verifySignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match?.[1]) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
