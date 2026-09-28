import { describe, expect, test, vi } from "vitest";
import { searchEmails } from "./gmail.js";

describe("searchEmails", () => {
  test("lists message ids, then fetches metadata (subject/from/snippet) for each", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) {
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: "msg-1" }, { id: "msg-2" }] }) } as unknown as Response;
      }
      const id = url.match(/messages\/([^?]+)/)![1];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snippet: `snippet for ${id}`,
          payload: { headers: [{ name: "Subject", value: `Subject ${id}` }, { name: "From", value: `sender-${id}@example.com` }] },
        }),
      } as unknown as Response;
    });

    const results = await searchEmails("token-abc", "in:inbox is:unread", 5, fetchImpl);

    expect(results).toEqual([
      { subject: "Subject msg-1", from: "sender-msg-1@example.com", snippet: "snippet for msg-1" },
      { subject: "Subject msg-2", from: "sender-msg-2@example.com", snippet: "snippet for msg-2" },
    ]);
  });

  test("the query and maxResults are passed through to the list request", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) }) as unknown as Response);
    await searchEmails("token", "from:someone", 3, fetchImpl);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain(encodeURIComponent("from:someone"));
    expect(url).toContain("maxResults=3");
  });

  test("no results is an empty array, not an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    expect(await searchEmails("token", "nothing matches this", 5, fetchImpl)).toEqual([]);
  });

  test("a missing subject/from falls back to sensible defaults, never throws on absent headers", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ snippet: "hi", payload: { headers: [] } }) } as unknown as Response;
    });
    const results = await searchEmails("token", "q", 5, fetchImpl);
    expect(results[0]!.subject).toBe("(no subject)");
    expect(results[0]!.from).toBe("");
  });

  test("throws with Google's own error message when the list request fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid Credentials" } }) }) as unknown as Response);
    await expect(searchEmails("bad-token", "q", 5, fetchImpl)).rejects.toThrow(/Invalid Credentials/);
  });
});
