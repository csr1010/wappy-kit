# Wappy Agent SDK

### The open-source WhatsApp Agent Operating System. Bring your own model, your own number, your own data.

[![CI](https://github.com/csr1010/wappy-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/csr1010/wappy-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/%40wappy%2Fcreate-agent?label=%40wappy%2Fcreate-agent)](https://www.npmjs.com/package/@wappy/create-agent)
[![Local-first](https://img.shields.io/badge/local--first-%E2%9C%94-brightgreen)](#why-this-exists)

## Install

```bash
npm create @wappy/agent
cp .env.sample .env    # fill in your model key + WhatsApp creds
npm install
npm run dev             # boots the server, opens a tunnel, prints the URL for Meta's webhook config
```

Here's the whole install, start to finish:

```
$ npm create @wappy/agent

┌  Wappy agent setup — let's set up your WhatsApp agent
│
◆  Which model provider will you use?
│  ● Anthropic
│  ○ OpenAI
│  ○ Gemini
│  ○ Local Ollama
└
◇  Interview complete — generating your project...

Done — 6 file(s) written in ./my-agent.
See README.md for next steps. Full WhatsApp connection walkthrough in WHATSAPP_SETUP.md.
```

That single prompt is the entire interview. Everything else, memory, context, reply formatting,
is already wired and running on your own machine the moment it finishes. Nobody's server sits in
the middle. Nobody can shut it off.

## What it does

Ever tried building a bot on WhatsApp with one of the usual tools out there and hit one of these?
Yeah, us too. These are real complaints about the drag-and-drop tools and canned chatbot builders,
not this project. Here's what actually goes wrong with those, and what happens here instead.

- 🔒 **"Wait, where's my data actually going?"** With most tools, it's on their server, not yours.
  Here, memory, chat history, even the model reading your documents, all of it lives in one plain
  file on your own machine. Nothing leaves unless you say so.
- 🧠 **"Wait, why did my agent just forget what we were talking about?"** Most bots only keep the
  raw chat log, so the second a message scrolls past, the thread is gone, and a one-word reply like
  "medium" three days later reads as gibberish. This one keeps a real session profile: what's
  actually going on right now, not just old messages, so it still knows exactly what that's an
  answer to, and the conversation never has to restart from zero.
- ⚡ **"Why is even a simple message burning through my API credits?"** It's not really about
  saying "hi" specifically. It's that most bots run every message through the same expensive path
  no matter how simple it is. This one routes first: a lightweight decision step figures out whether
  a message actually needs a data lookup or a tool call before anything expensive happens, so a
  plain message gets a plain, cheap answer, and only the ones that truly need it pay for it.
- 🎛️ **"Why does every reply look like the same copy-pasted template?"** Because most bots have no
  memory and no context, so every single person gets the exact same canned message back. This one
  personalizes: the same agent harness that remembers who it's talking to also decides, live, what
  shape the reply should take, text, buttons, a list, a link, tailored to what's actually being
  said instead of one hardcoded format for everyone.
- 🛑 **"What if it fires the same charge twice?"** It won't. Anything real, a charge, a
  cancellation, waits for an actual confirmation first, and can never double-fire by mistake.
- 🧩 **"So what am I locked into?"** Nothing. Your number, your model, your own tools and APIs. No
  vendor holding the leash.

Tested by hand against a real WhatsApp number, not just automated checks. If it's in here, it works.

## Packages

| Package | What it is |
|---|---|
| `@wappy/core` | The shared contracts everything else is built on. |
| `@wappy/harness` | The agent itself: how it thinks, remembers, and decides what to do. |
| `@wappy/whatsapp` | Talking to WhatsApp correctly: message formatting, retries, a real webhook server. |
| `@wappy/create-agent` | The installer (`npm create @wappy/agent`). One question, then a working project. |

Every install pulls in exactly these four. Nothing extra, nothing tied to a business or use case.

## Why this exists

The real problem was never the drag-and-drop canvas. It's that there was no easy way to actually
plug your own data and logic into WhatsApp without it turning into a full custom build. So you
either settle for a canned chatbot, or you build everything yourself from scratch, and most people
give up and go back to a spreadsheet and a phone.

Wappy Agent SDK is the easy way in without giving up control: talk to WhatsApp correctly, remember who
you're talking to, reply in whatever shape fits, so you spend your time on what your agent
actually does, not on rebuilding the basics.

## What you can build on it

This isn't built around one use case. It's a real agent with memory, context, and a decision loop
already working, WhatsApp is just the surface. Whatever business already runs on some system with
real data behind it (a CRM, a booking calendar, a ticketing tool, an inventory sheet, an internal
API) can have that system answering customers on WhatsApp directly, the moment you wire its tools
in. That's not a small list of "supported integrations," it's anything you can call from code,
which is close to everything:

- 🏋️ **A fitness coach** that reads your Fitbit data and finds you a gym nearby.
- 🛍️ **A commerce agent** that checks stock and looks up real order status.
- 🎫 **A support agent** that resolves things in your ticketing system, instead of collecting an
  email and vanishing.
- 🍽️ **A booking agent** for a restaurant, a clinic, a studio, anything with a reservations system.
- 🏠 **A leasing agent** that answers "is this still available" from your real listings.
- 🧠 **A personal assistant** wired to your calendar, your notes, your own tools.
- 📚 **A doc-grounded expert**, answers grounded in what you actually gave it, running entirely
  on your machine.
- 🏢 **An internal ops bot** for IT, HR, whatever your company already runs, reachable from the
  app your team already has open all day.

None of that ships in this repo, on purpose. This handles WhatsApp and the thinking. Your product
idea is yours to build on top, using the same building blocks the core already uses. No forking
required.

## Requirements

- **Node.js 20+**
- **A WhatsApp Cloud API app.** Free, via [Meta's developer portal](https://developers.facebook.com/apps). You'll need a phone number, an access token, and an app secret. The generated project's own README walks you through every field.
- **A model API key.** OpenAI, Anthropic, or Gemini. Or skip it entirely and run fully offline against local Ollama.

No credit card. No signup for Wappy Agent SDK itself. No forced cloud service in the critical path. The
only network calls a generated project makes are to the providers you chose.

## For contributors (and your coding agent)

Early days, genuinely pre-1.0. Open to any kind of feedback. See [`ARCHITECTURE.md`](ARCHITECTURE.md)
and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](./LICENSE).

---

*Built for developers who want a real agent on WhatsApp, not another flowchart.*

*Not affiliated with, endorsed by, or sponsored by WhatsApp or Meta. This project talks to the public WhatsApp Cloud API, the same one any developer can request access to.*
