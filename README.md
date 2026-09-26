# Wappy Kit

### The open-source WhatsApp Agent Operating System. Bring your own model, your own number, your own data.

[![CI](https://github.com/csr1010/wappy-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/csr1010/wappy-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/%40wappy%2Fcreate-agent?label=%40wappy%2Fcreate-agent)](https://www.npmjs.com/package/@wappy/create-agent)
[![Local-first](https://img.shields.io/badge/local--first-%E2%9C%94-brightgreen)](#why-this-exists)

Say you wanted to build something real on WhatsApp. Not a chatbot demo, an actual product: something that talks to your customers, checks your real data, remembers what someone said yesterday.

You go looking for tools. Every one of them wants you to drag boxes on a canvas and pick from a menu of canned replies. None of them let you plug in your own database. None of them remember the conversation past a few messages. And most of them want a monthly fee before you've even shipped anything.

So most people just give up and stick with a spreadsheet and a phone.

That's the gap Wappy Kit closes. It's the plumbing underneath a real WhatsApp agent: the part that talks to WhatsApp correctly, remembers who it's talking to, and knows how to reply in a way that fits, so you can spend your time on what your agent actually does, not on getting the basics right from scratch.

```bash
npm create @wappy/agent
```

Answer one question. You get a real agent, running on your machine, using whichever AI model you pick, already able to remember and reply properly. Nobody's server sits in the middle. Nobody can shut it off.

---

## Why this exists

The tools already out there (Twilio, Gupshup, Landbot, and the rest) are built for flowcharts, not agents. They can't call your own API. They forget the conversation the moment it gets past step three. And you're renting all of it.

If you already run a store, a booking system, a support desk, anything with real data behind it, there was no simple way to put a real, thinking agent in front of it on WhatsApp, one that's actually yours. So this exists to fix that.

- 🔒 **It runs on your own machine.** Memory, the conversation so far, even the AI that reads your documents, all of it lives in a plain file on your computer. Nothing gets sent anywhere unless you decide to.
- 🧠 **It actually remembers.** Not just the raw chat log, but what's actually going on right now, so if someone replies with just "medium," the agent still knows what they're answering.
- ⚡ **It's not wasteful.** A simple "hi" doesn't need to search a database or call an expensive AI model. The agent figures out the cheapest way to answer correctly, every single time.
- 🎛️ **It picks the right reply format itself.** Sometimes that's plain text. Sometimes it's buttons, or a list, or a link. The agent decides based on what it's actually saying, not a template someone hardcoded.
- 🛑 **It doesn't do anything risky by accident.** If a reply is about to actually do something (charge a card, cancel a booking), it waits for a real confirmation first, and it won't ever do that thing twice by mistake.
- 🧩 **You bring everything else.** Your number, your AI model of choice, and any of your own tools or APIs you want it to use. This project never locks you into a single vendor for any of that.

We tested this by hand against a real WhatsApp number, not just automated checks. If it's in here, it actually works.

## What's actually in the box

Every install pulls in exactly these. Nothing extra, nothing tied to any specific business or use case.

| Package | What it is |
|---|---|
| `@wappy/core` | The shared contracts everything else is built on. |
| `@wappy/harness` | The agent itself: how it thinks, remembers, and decides what to do. |
| `@wappy/whatsapp` | Everything about actually talking to WhatsApp correctly: message formatting, retries, a real webhook server. |
| `@wappy/create-agent` | The installer (`npm create @wappy/agent`). One question, then a working project. |

**One command install, one webhook server, one real agent:**

```bash
npm create @wappy/agent
cp .env.sample .env    # fill in your model key + WhatsApp creds
npm install
npm run dev             # boots the server, opens a tunnel, prints the URL for Meta's webhook config
```

Text your number. Get a real reply, from your own model, grounded in memory that's actually yours.

## What you can build on it

```
? Which model provider will you use? Anthropic
```

One question. Then a real, working project, memory and context already handled, ready for you to give it tools:

- 🏋️ **A fitness coach** that reads your Fitbit data, nudges you to work out, and finds a gym nearby.
- 🛍️ **A commerce agent** that searches your catalog, checks stock, and looks up real order status.
- 🎫 **A support agent** that actually resolves things in your ticketing system, instead of collecting an email and vanishing.
- 🍽️ **A booking agent** for a restaurant, a clinic, a studio. Anything with a reservations system.
- 🏠 **A leasing agent** that answers "is this still available" from your real listings, not a spreadsheet nobody updated.
- 🧠 **A personal assistant** wired to your calendar, your notes, your own tools.
- 📚 **A doc-grounded expert.** Feed it your own policies or manuals and get answers grounded in what you actually gave it, running entirely on your machine.
- 🏢 **An internal ops bot.** IT helpdesk, HR questions, whatever your company already runs, now reachable from the app your team already has open all day.

None of that ships in this repo, on purpose. This project handles WhatsApp and the agent's thinking. Your product idea, and whatever it needs to connect to, is yours to build on top, using the same building blocks the core already uses. No forking required.

## Requirements

- **Node.js 20+**
- **A WhatsApp Cloud API app.** Free, via [Meta's developer portal](https://developers.facebook.com/apps). You'll need a phone number, an access token, and an app secret. The generated project's own README walks you through every field.
- **A model API key.** OpenAI, Anthropic, or Gemini. Or skip the key entirely and run fully offline against local Ollama.

No credit card. No signup for Wappy Kit itself. No forced cloud service in the critical path. The only network calls a generated project makes are to the providers you chose.

## For contributors (and your coding agent)

Early days, genuinely pre-1.0, being built in the open. Issues, PRs, and "this broke on my machine" reports are all welcome.

If you're extending this yourself, or pointing your own coding agent at this repo, start with [`ARCHITECTURE.md`](ARCHITECTURE.md): what each package does, why it's built the way it is, and where to look first. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup steps and ground rules for sending a PR.

## License

MIT. See [`LICENSE`](./LICENSE).

---

*Built for developers who want a real agent on WhatsApp, not another flowchart.*

*Not affiliated with, endorsed by, or sponsored by WhatsApp or Meta. This project talks to the public WhatsApp Cloud API, the same one any developer can request access to.*
