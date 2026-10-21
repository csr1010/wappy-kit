import "dotenv/config";
import { createInMemoryTracer, systemClock } from "@wappy_ai/core";
import { createAgent, createKnowledge, createKnowledgeRag, createLibsqlMemory, createLibsqlSessionProfileStore, createLlmRouter, createVercelModel } from "@wappy_ai/harness";
import { createWhatsAppChannel } from "@wappy_ai/whatsapp";
import { createClient } from "@libsql/client";
import { createConnectUiServer, createGoogleAssistant } from "@wappy_ai/productivity";
import { createCalendarSearchFn, createGmailSearchFn, createGoogleOAuthPlugin, createGoogleTokenStore } from "@wappy_ai/connector-google";
import { openai } from "@ai-sdk/openai";

const model = createVercelModel({ model: openai(process.env.OPENAI_MODEL ?? "gpt-4o") });
const memory = createLibsqlMemory({ url: process.env.MEMORY_DB_URL ?? "file:.wappy/memory.db" });
const sessionProfileStore = createLibsqlSessionProfileStore({ url: process.env.SESSION_PROFILE_DB_URL ?? "file:.wappy/session-profile.db" });
const router = createLlmRouter({ model });
const tracer = createInMemoryTracer();

const knowledgeClient = createClient({ url: process.env.KNOWLEDGE_DB_URL ?? "file:.wappy/knowledge.db" });
const knowledge = createKnowledge({ client: knowledgeClient });
const retrieveRag = createKnowledgeRag({ knowledge, memory });

export const channel = createWhatsAppChannel({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  clock: systemClock,
});

// This scaffold ships with no tools wired in. To give the agent tools (a store, a
// calendar, anything else), see @wappy_ai/core's Tool/ToolProvider interfaces and
// @wappy_ai/harness's docs on wiring a tool invoker into createAgent below.
export const reactiveAgent = createAgent({
  channel, memory, router, model, tracer,
  clock: systemClock,
  sessionProfileStore,
  retrieveRag,
});

// Productivity agent: reads (never writes) the user's own Gmail/Calendar, for ANY question
// phrased in normal language — no saved tasks, no fixed list of things it can answer. See
// GOOGLE_SETUP.md for the one-time Google connection; without it, a matched question just
// replies honestly that it needs "Connect Google" tapped first on the local connect page.
const googleConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3001/google/callback",
};
const googleTokenStore = createGoogleTokenStore({ url: process.env.GOOGLE_TOKENS_DB_URL ?? "file:.wappy/google-tokens.db" });
const googlePlugin = createGoogleOAuthPlugin({ config: googleConfig, tokenStore: googleTokenStore, clock: systemClock });

const googleAssistant = createGoogleAssistant({
  model, clock: systemClock,
  connectors: {
    gmail: createGmailSearchFn({ config: googleConfig, tokenStore: googleTokenStore, clock: systemClock }),
    calendar: createCalendarSearchFn({ config: googleConfig, tokenStore: googleTokenStore, clock: systemClock }),
  },
});

// Wraps the reactive agent: every inbound message is offered real Gmail/Calendar search tools
// first (the model itself decides whether the message actually needs them, and constructs its
// own query/date-range — @wappy_ai/harness's createVercelModel already runs the full
// multi-step tool-calling loop internally); anything that didn't touch either tool falls
// through to the normal reactive agent unchanged.
export const agent = {
  async handle(message: Parameters<typeof reactiveAgent.handle>[0]) {
    const routed = await googleAssistant.maybeHandle(message);
    if (routed.handled) return channel.send(message.contactId, { text: routed.reply! });
    return reactiveAgent.handle(message);
  },
};

export const taskUiServer = createConnectUiServer({ oauthConnect: googlePlugin });
