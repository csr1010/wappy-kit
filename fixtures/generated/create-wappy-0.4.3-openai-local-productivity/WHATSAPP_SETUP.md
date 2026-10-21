# Connecting WhatsApp

This is the one part of setup that isn't just filling in `.env`. It has two halves: getting
real WhatsApp Cloud API credentials, and giving Meta a URL it can reach even though your agent
is running on your own machine right now, not a public server.

## 1. Create the Meta app and get your credentials

1. Go to https://developers.facebook.com/apps and create an app (type: Business).
2. Add the **WhatsApp** product to it.
3. Under WhatsApp → API Setup, you'll see a test phone number already provided. Copy its
   **Phone number ID** and the **temporary access token** shown there into `.env` as
   `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`. (That token expires in 24 hours —
   fine for trying this out; for anything longer-lived, create a System User token instead,
   under Business Settings → System Users.)
4. Under App settings → Basic, copy the **App secret** into `.env` as `WHATSAPP_APP_SECRET`.
   This is what lets the webhook server verify a request actually came from Meta.
5. Make up any string yourself (a password you invent, not something Meta gives you) and put
   it in `.env` as `WHATSAPP_VERIFY_TOKEN`. You'll enter this exact same string into Meta's
   webhook config in step 3 below — it's just a shared secret the two sides agree on.

## 2. Get a public URL for your local machine

Meta needs to send webhook requests to a real, public URL. Your machine doesn't have one by
default, so `npm run dev` (which runs `wappy dev`) opens a tunnel for you automatically and
prints a public URL that forwards to your local server. You don't need to install or
configure anything extra for this — it's already wired in.

```sh
npm run dev
# ...
# Webhook server listening on http://localhost:3000/webhook
# Public webhook URL: https://some-random-name.loca.lt/webhook
```

Keep that command running while you're testing. If you'd rather use your own tunnel (ngrok,
Cloudflare Tunnel, etc.) instead of the built-in one, run `npm run dev -- --no-tunnel` and point
your own tunnel at `http://localhost:3000/webhook` — either way, what Meta needs in the next
step is whatever public URL ends in `/webhook`.

## 3. Point Meta's webhook at that URL

1. In the Meta app, go to WhatsApp → Configuration.
2. Under Webhook, click Edit and paste in the public URL from step 2 (the one ending in
   `/webhook`), plus the same `WHATSAPP_VERIFY_TOKEN` string you put in `.env`.
3. Click Verify and save — Meta calls your webhook once to confirm it's really up, and your
   server (already running from step 2) answers that check automatically.
4. Under "Webhook fields," subscribe to **messages**. Without this, Meta never actually
   forwards incoming messages to your webhook, even once verification succeeds.

## 4. Test it

Send a WhatsApp message to the test number shown on the API Setup page. It should reach your
running `npm run dev` process and get a real reply back.

If nothing happens: check the terminal running `npm run dev` for errors first, then re-check
that the webhook shows as verified and subscribed to `messages` in Meta's UI. `wappy doctor`
(once available) checks your `.env` and connectivity for you.

A new tunnel URL from the built-in tunnel changes every time you restart `npm run dev` — if
you stop and restart it, you'll need to paste the new URL back into Meta's webhook config.

## 5. About the productivity agent and WhatsApp Message Templates

You do **not** need to set up a WhatsApp Message Template for anything in this project. A
Message Template is Meta's requirement for a message your agent sends unprompted, outside the
24 hours since the contact last messaged you — this project deliberately never does that.
Every reply, including a matched productivity task's, is a direct response to something the
contact just said, so it's always inside that open window. See GOOGLE_SETUP.md for connecting
Gmail/Calendar, which is the only extra setup the productivity agent needs.
