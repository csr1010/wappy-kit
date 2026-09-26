# Wappy Kit

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

One question (which model provider you're using), and you get a real agent running on your own
machine. Nobody's server sits in the middle. Nobody can shut it off.

## What it does

- 🔒 **Runs on your machine.** Memory, conversation history, even the model that reads your
  documents, all of it stays in a plain local file. Nothing leaves unless you decide it should.
- 🧠 **Actually remembers.** Not just the raw chat log, what's actually going on right now. Someone
  replies "medium" three days later, it still knows what that's an answer to.
- ⚡ **Doesn't waste calls.** A "hi" doesn't trigger a database search or an expensive model call.
  It figures out the cheapest correct way to answer, every time.
- 🎛️ **Picks its own reply format.** Text, buttons, a list, a link, whatever fits what it's
  actually saying, not a template someone hardcoded.
- 🛑 **Confirms before anything risky.** A charge, a cancellation, anything that does something real
  waits for an actual confirmation, and can never fire twice by mistake.
- 🧩 **You bring the rest.** Your number, your model, your own tools and APIs. No vendor lock-in
  anywhere in the stack.

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

Every WhatsApp tool out there wants you dragging boxes on a canvas, picking from a dropdown of
replies. None of them plug into your own data. None of them remember past three messages. All of
them charge before you've shipped anything. So people give up and go back to a spreadsheet and a
phone.

Wappy Kit is the missing plumbing: talk to WhatsApp correctly, remember who you're talking to,
reply in whatever shape fits, so you spend your time on what your agent actually does, not on
rebuilding the basics.

## What you can build on it

```
? Which model provider will you use? Anthropic
```

One question, then memory and context already handled, ready for you to give it tools:

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

No credit card. No signup for Wappy Kit itself. No forced cloud service in the critical path. The
only network calls a generated project makes are to the providers you chose.

## For contributors (and your coding agent)

Early days, genuinely pre-1.0, being built in the open. Issues, PRs, and "this broke on my machine"
reports are all welcome.

If you're extending this yourself, or pointing your own coding agent at this repo, start with
[`ARCHITECTURE.md`](ARCHITECTURE.md): what each package does, why it's built the way it is, and
where to look first. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup steps and ground rules for
sending a PR.

## License

MIT. See [`LICENSE`](./LICENSE).

---

*Built for developers who want a real agent on WhatsApp, not another flowchart.*

*Not affiliated with, endorsed by, or sponsored by WhatsApp or Meta. This project talks to the public WhatsApp Cloud API, the same one any developer can request access to.*
