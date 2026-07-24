import { describe, expect, test } from "vitest";
import { signWebhook } from "@wappy/testkit";
import { verifySignature } from "./signature.js";

const secret = "app-secret-123";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

describe("verifySignature", () => {
  test("accepts a correctly signed body", () => {
    expect(verifySignature(body, signWebhook(body, secret), secret)).toBe(true);
  });

  test("rejects a forged signature (wrong secret)", () => {
    expect(verifySignature(body, signWebhook(body, "wrong-secret"), secret)).toBe(false);
  });

  test("rejects a tampered body (signature no longer matches)", () => {
    const sig = signWebhook(body, secret);
    expect(verifySignature(body + " ", sig, secret)).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  test("rejects a malformed header (no sha256= prefix, bad hex, wrong length)", () => {
    expect(verifySignature(body, "not-a-signature", secret)).toBe(false);
    expect(verifySignature(body, "sha1=deadbeef", secret)).toBe(false);
    expect(verifySignature(body, "sha256=zzzz", secret)).toBe(false);
    expect(verifySignature(body, "sha256=" + "a".repeat(63), secret)).toBe(false);
  });

  test("handles a large unicode body", () => {
    const bigBody = JSON.stringify({ text: "héllo 👋 ".repeat(10_000) });
    expect(verifySignature(bigBody, signWebhook(bigBody, secret), secret)).toBe(true);
  });

  test("verifies against a Buffer the same as a string (raw-bytes requirement)", () => {
    const sig = signWebhook(body, secret);
    expect(verifySignature(Buffer.from(body, "utf8"), sig, secret)).toBe(true);
  });
});
