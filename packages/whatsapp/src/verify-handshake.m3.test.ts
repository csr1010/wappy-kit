import { describe, expect, test } from "vitest";
import { handleVerifyHandshake } from "./verify-handshake.js";

describe("handleVerifyHandshake", () => {
  test("succeeds with the correct mode/token, echoing the challenge", () => {
    const result = handleVerifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "secret", "hub.challenge": "12345" }, "secret");
    expect(result).toEqual({ ok: true, challenge: "12345" });
  });

  test("fails with the wrong verify_token", () => {
    expect(handleVerifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }, "secret")).toEqual({ ok: false });
  });

  test("fails with the wrong mode", () => {
    expect(handleVerifyHandshake({ "hub.mode": "unsubscribe", "hub.verify_token": "secret", "hub.challenge": "1" }, "secret")).toEqual({ ok: false });
  });

  test("fails with a missing challenge", () => {
    expect(handleVerifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "secret" }, "secret")).toEqual({ ok: false });
  });

  test("fails on an entirely empty query", () => {
    expect(handleVerifyHandshake({}, "secret")).toEqual({ ok: false });
  });
});
