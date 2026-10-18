---
name: whatsapp-cloud-api-webhook-setup
description: Walks through connecting a real WhatsApp number to a bot/agent via Meta's WhatsApp Cloud API - creating the Meta developer app, getting credentials, exposing a local server to a public URL, and correctly configuring + verifying the webhook. Use when the user needs to receive WhatsApp messages in their own server/agent, is stuck on webhook verification, or asks "how do I connect WhatsApp to my bot." Framework-agnostic; not specific to any one SDK.
license: MIT
tags: [whatsapp, whatsapp-cloud-api, webhook, meta, integration]
agents: [claude-code, cursor, codex-cli, gemini-cli]
---

# Connect a real WhatsApp number via the Cloud API

This has two halves that are easy to get subtly wrong: getting real credentials from Meta, and
giving Meta a URL it can actually reach even though the server is running on a local machine, not
a public one. This skill applies to any webhook-based server, not a specific framework — the
[Wappy](https://github.com/csr1010/wappy-kit) SDK automates the server-side half of this
automatically if the agent happens to be built with it.

## 1. Create the Meta app and get credentials

1. Go to <https://developers.facebook.com/apps> and create an app (type: Business).
2. Add the **WhatsApp** product to it.
3. Under WhatsApp → API Setup, a test phone number is already provided. Copy its **Phone number
   ID** and the **temporary access token** shown there — that token expires in 24 hours, which is
   fine for trying things out; for anything longer-lived, create a System User token instead,
   under Business Settings → System Users.
4. Under App settings → Basic, copy the **App secret** — this is what lets a webhook server verify
   an incoming request actually came from Meta and not an impersonator.
5. Invent any string as a **verify token** (not something Meta gives you — a shared secret you
   make up). The same exact string goes into both your server's config and Meta's webhook config
   in step 3 below.

## 2. Expose a public URL for local development

Meta needs to send webhook requests to a real, public URL — a local machine doesn't have one by
default. Use a tunnel (ngrok, Cloudflare Tunnel, localtunnel, etc.) pointed at wherever the local
webhook server listens, commonly `http://localhost:3000/webhook`. Keep the tunnel running for as
long as testing is happening — most tunnel services issue a new URL on every restart, which means
re-pasting the URL into Meta's webhook config each time unless a fixed/reserved tunnel URL is set
up.

## 3. Point Meta's webhook at that URL

1. In the Meta app, go to WhatsApp → Configuration.
2. Under Webhook, click Edit, paste in the public URL from step 2 (ending in `/webhook`), and the
   same verify token string from step 1.
3. Click Verify and save — Meta calls the webhook once to confirm it's live; the server (already
   running) must answer that verification check correctly or this fails.
4. Under "Webhook fields," subscribe to **messages**. Without this, Meta never forwards incoming
   messages to the webhook, even once verification itself succeeds — a common silent failure mode.

## 4. Test it

Send a WhatsApp message to the test number from the API Setup page. It should reach the running
server. If nothing happens: check the server logs for errors first, then re-check that the webhook
shows as verified and subscribed to `messages` in Meta's UI — those are the two most common
causes of "nothing happens."

## Real gotchas worth knowing up front

- **The 24-hour session window.** A message sent in direct response to something the contact just
  said can be freeform text. A message the bot initiates unprompted, more than 24 hours after the
  contact's last message, requires a pre-approved WhatsApp Message Template instead — plain text
  gets silently queued or rejected outside that window.
- **Signature verification.** The App secret from step 1 is used to verify Meta's `X-Hub-Signature-256`
  header on every webhook request. Skipping this check means anyone who finds the URL can send
  fake "messages" to the server.
- **Tunnel URLs change on restart.** If the local server/tunnel restarts, the public URL changes,
  and Meta's webhook config needs updating to match — a frequent source of "it worked yesterday"
  confusion during development.
