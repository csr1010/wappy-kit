/** Meta's GET webhook verification handshake (subscribe once, at webhook-URL setup time). */
export interface VerifyHandshakeQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}

export type VerifyHandshakeResult = { ok: true; challenge: string } | { ok: false };

export function handleVerifyHandshake(query: VerifyHandshakeQuery, expectedVerifyToken: string): VerifyHandshakeResult {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === expectedVerifyToken && typeof query["hub.challenge"] === "string") {
    return { ok: true, challenge: query["hub.challenge"] };
  }
  return { ok: false };
}
