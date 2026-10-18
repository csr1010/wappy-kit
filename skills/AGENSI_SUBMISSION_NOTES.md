# Submitting these to Agensi.io

Reference notes for listing the two skills in this folder on [agensi.io](https://www.agensi.io),
a marketplace for `SKILL.md`-format AI agent skills. Not itself a skill — internal/reference only.

## What this covers vs. what you need to do yourself

This repo provides the finished, validated `SKILL.md` content. Account creation, identity/payment
verification, and the actual submission click all require your own identity and cannot be done on
your behalf. See the checklist at the bottom.

## Listing 1 — `scaffold-whatsapp-agent/`

- **Title**: Scaffold a WhatsApp AI Agent
- **Description** (for the listing page, separate from the SKILL.md frontmatter description):
  "Generates a complete, runnable AI agent that connects to WhatsApp, using the open-source Wappy
  SDK — your own model key, your own number, your own data. One command, under a minute."
- **Tags**: `whatsapp`, `ai-agent`, `typescript`, `scaffolding`, `cli`
- **Price**: Free
- **Link back**: <https://github.com/csr1010/wappy-kit>

## Listing 2 — `whatsapp-cloud-api-webhook-setup/`

- **Title**: WhatsApp Cloud API Webhook Setup
- **Description**: "Walks through connecting a real WhatsApp number to any bot or agent via Meta's
  WhatsApp Cloud API — credentials, exposing a local server publicly, and webhook verification.
  Framework-agnostic, with the real gotchas (session window, signature verification) included."
- **Tags**: `whatsapp`, `whatsapp-cloud-api`, `webhook`, `meta`, `integration`
- **Price**: Free
- **Link back**: <https://github.com/csr1010/wappy-kit>

## Packaging a submission zip

Per Agensi's required layout, `SKILL.md` must sit at the root of the zip (not nested in an extra
folder):

```sh
cd skills/scaffold-whatsapp-agent && zip -r ../scaffold-whatsapp-agent.zip SKILL.md
cd ../whatsapp-cloud-api-webhook-setup && zip -r ../whatsapp-cloud-api-webhook-setup.zip SKILL.md
```

Neither skill bundles supporting scripts or assets — pure instructional content, so just the one
file per zip.

## Manual steps (only you can do these)

1. Create an account at <https://www.agensi.io>.
2. Connect Stripe via Stripe Connect — **required even for free listings**. This needs your real
   identity/bank verification; no way around it, and not something that can be done on your
   behalf.
3. Open the Creator Dashboard, submit each zip with the title/description/tags/price above.
4. Each listing goes through an automated security scan plus a manual review (Agensi states
   24–48 hours). Neither skill contains scripts, requests elevated tool permissions, or embeds any
   secrets, so there's no expected reason for either to fail that review — but the outcome itself
   is out of our control.
5. Once live, the listing URLs are worth adding to the main repo README's "Skills" or similar
   section, if you want the loop closed (repo → Agensi → repo).
