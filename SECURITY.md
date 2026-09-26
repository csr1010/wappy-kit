# Security Policy

Wappy Kit handles real credentials: WhatsApp Cloud API access tokens, model provider API keys, and
webhook signing secrets. Please report security issues responsibly rather than opening a public
issue.

## Reporting a vulnerability

Email **csrj0425@gmail.com** with:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept if you have one.
- Which package(s)/version(s) are affected.

You should get an acknowledgment within a few days. Please don't publicly disclose the issue until
a fix has shipped, or 90 days have passed, whichever comes first.

## Scope

In scope:

- `@wappy/core`, `@wappy/harness`, `@wappy/whatsapp`, `@wappy/create-agent` (this repo).
- Anything that could leak a credential, bypass webhook signature verification, allow a
  confirm-before-write tool to execute without real confirmation, or allow a crafted inbound
  message to execute unintended code.

Out of scope:

- Vulnerabilities in a *generated* project's own custom tools/connectors, unless the root cause is
  in this repo's own code.
- The WhatsApp Cloud API or any model provider's own infrastructure (report those to Meta/the
  provider directly).

## What's already handled

A few things worth knowing up front, since they shape what a report should focus on:

- Secrets are never generated into committed files. `.env`/`.wappy/` are git-ignored by every
  generated project; credentials only ever live in environment variables, read at call time.
- Every outbound HTTP call this repo makes goes through an SSRF guard (address-classification
  allow-list, DNS-rebinding-safe connection pinning, redirect re-validation on every hop).
- Webhook signatures are verified before a payload is ever processed.
- A tool marked `confirmBefore: true` is held pending, keyed to the specific confirmation it was
  issued for, and can't be replayed or confused with a different pending action (see
  `packages/harness/src/confirm.ts`).
