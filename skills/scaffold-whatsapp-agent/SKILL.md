---
name: scaffold-whatsapp-agent
description: Scaffolds a real, working AI agent that runs on WhatsApp, using the open-source Wappy SDK (npm create @wappy_ai/agent). Use when the user asks to build, scaffold, or prototype a WhatsApp bot, WhatsApp AI agent, or a personal/support/booking agent that should run on WhatsApp. Generates runnable TypeScript, not a template to fill in by hand.
license: MIT
tags: [whatsapp, ai-agent, typescript, scaffolding, cli, local-first]
agents: [claude-code, cursor, codex-cli, gemini-cli]
---

# Scaffold a WhatsApp AI agent

[Wappy](https://github.com/csr1010/wappy-kit) is an open-source SDK for building AI agents on
WhatsApp: your own model key, your own WhatsApp number, your own data. Nothing routes through a
third-party server. One command generates a complete, runnable project — not a template with
placeholders to fill in.

## When to use this

The user wants to build something that runs *on WhatsApp specifically* — a personal assistant, a
support bot, a booking agent, or any agent reachable from the WhatsApp app itself, as opposed to a
web chat widget or a Slack/Discord bot.

## Scaffold it

```sh
npm create @wappy_ai/agent
```

This runs a short interactive interview with three questions, in this order:

1. **Model provider** — `openai`, `anthropic`, `gemini`, or `ollama` (fully local, no API key).
2. **Memory backend** — `local` (SQLite/LibSQL, no account, BM25 keyword search) or `cognee`
   (a self-hosted or cloud knowledge-graph service for retrieval; needs its own running instance).
3. **Productivity agent** — optionally include a sample Gmail/Calendar assistant that answers
   plain-language questions about the user's own Google account (read-only).

## Non-interactive / scripted use

Every interview question has a matching flag, for CI or when a human isn't present to answer
prompts interactively:

```sh
npm create @wappy_ai/agent -- --yes --model anthropic --memory local --productivity no --dir my-agent
```

Flags: `--model <openai|anthropic|gemini|ollama>`, `--memory <local|cognee>`,
`--productivity <yes|no>`, `--dir <path>` (target directory, default: current directory), `--yes`
(skip confirmation), `--help`.

## After scaffolding

```sh
cd my-agent               # if --dir was used
cp .env.sample .env       # fill in the model key + WhatsApp credentials it lists
npm install
npm run dev                # boots the webhook server, opens a tunnel, prints the webhook URL
```

Connecting the generated project to a real WhatsApp number (creating the Meta app, verifying the
webhook) is its own, separate process — see the `whatsapp-cloud-api-webhook-setup` skill, or the
generated project's own `WHATSAPP_SETUP.md`, for that part.

## What gets generated

A real TypeScript project: an `index.ts` wiring together memory, a routed reply pipeline (decides
per-message whether a tool call or retrieval lookup is actually needed before paying for it),
WhatsApp message handling, and — if chosen — the productivity agent and/or Cognee client. A
`.env.sample` listing every credential the specific generated project actually needs, nothing
unused. A `README.md` and `WHATSAPP_SETUP.md` (and `GOOGLE_SETUP.md`/`COGNEE_SETUP.md` if those
features were chosen) with the exact next steps for that project.

## Requirements

Node.js 22+. A WhatsApp Cloud API app (free, via
[Meta's developer portal](https://developers.facebook.com/apps)). A model API key for the chosen
provider, or skip entirely and run fully offline against local Ollama.
