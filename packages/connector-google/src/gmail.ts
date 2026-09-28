import type { FetchImpl } from "./oauth.js";

/**
 * Real Gmail API v1. `messages.list` only returns `{id, threadId}` (no subject/snippet) — a real,
 * documented Gmail API behavior, not an oversight — so each result needs a follow-up `messages.get`
 * (metadata format: headers + snippet, not the full body) to get anything readable.
 */

export interface EmailSummary {
  subject: string;
  from: string;
  snippet: string;
}

interface MessageListResponse {
  messages?: { id: string }[];
  error?: { message?: string };
}
interface MessageGetResponse {
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
  error?: { message?: string };
}

function header(res: MessageGetResponse, name: string): string {
  return res.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** `query` is Gmail's own search syntax (e.g. `"from:someone subject:flight"`, or just plain words —
 * the same box you'd type into Gmail's own search bar). `maxResults` default 5, matching this
 * project's "smaller, safer, cheaper surface by default" convention elsewhere. */
export async function searchEmails(accessToken: string, query: string, maxResults = 5, fetchImpl: FetchImpl = fetch): Promise<EmailSummary[]> {
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listRes = await fetchImpl(listUrl.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
  const listJson = (await listRes.json()) as MessageListResponse;
  if (!listRes.ok) throw new Error(`Gmail API (list): ${listJson.error?.message ?? listRes.status}`);

  const ids = listJson.messages ?? [];
  const results: EmailSummary[] = [];
  for (const { id } of ids) {
    const getUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    getUrl.searchParams.set("format", "metadata");
    getUrl.searchParams.append("metadataHeaders", "Subject");
    getUrl.searchParams.append("metadataHeaders", "From");
    const getRes = await fetchImpl(getUrl.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
    const getJson = (await getRes.json()) as MessageGetResponse;
    if (!getRes.ok) throw new Error(`Gmail API (get ${id}): ${getJson.error?.message ?? getRes.status}`);
    results.push({ subject: header(getJson, "Subject") || "(no subject)", from: header(getJson, "From"), snippet: getJson.snippet ?? "" });
  }
  return results;
}
