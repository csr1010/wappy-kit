import "dotenv/config";
import { createInMemoryTracer, systemClock } from "@wappy_ai/core";
import { createAgent, createKnowledge, createKnowledgeRag, createLibsqlMemory, createLibsqlSessionProfileStore, createLlmRouter, createVercelModel } from "@wappy_ai/harness";
import { createWhatsAppChannel } from "@wappy_ai/whatsapp";
import { createClient } from "@libsql/client";
import { anthropic } from "@ai-sdk/anthropic";

const model = createVercelModel({ model: anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5") });
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
export const agent = createAgent({
  channel, memory, router, model, tracer,
  clock: systemClock,
  sessionProfileStore,
  retrieveRag,
});
