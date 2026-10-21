# Connecting Google (Calendar + Gmail)

The productivity agent needs this — real read access to your own Calendar and Gmail, full
read (never write, never a shared Wappy-operated account). Without it, a Gmail/Calendar
question just replies honestly that it needs "Connect Google" tapped first, instead of
failing silently.

## 1. Create your own Google Cloud OAuth client

This can't be skipped or automated — Google requires every app to be registered under
someone's own Cloud project, same category of one-time setup as WHATSAPP_SETUP.md.

1. Go to https://console.cloud.google.com and create a project (or use an existing one).
2. Go to APIs & Services → Library, enable **Google Calendar API** and **Gmail API**.
3. Go to APIs & Services → OAuth consent screen. Choose **External**, fill in the required
   fields, and leave Publishing status as **Testing** — this is a personal tool, not a
   public app, so Google's full app-review process doesn't apply (Testing mode supports up
   to 100 users, which is every user this project has).
4. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID.
5. Application type: **Web application**.
6. Under Authorized redirect URIs, add exactly: `http://localhost:3001/google/callback`
   (this must match `index.ts`'s `GOOGLE_REDIRECT_URI` default exactly — only change both
   together if you've customized `CONNECT_UI_PORT`).
7. Copy the **Client ID** and **Client secret** into `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.

## 2. Connect — one click, on the local connect page

Restart `npm run dev` after filling in `.env`. Open the connect page URL it prints — you'll
see a **Connect Google** card. Tap it, sign in with your own Google account, approve the real
consent screen (it will look unverified, since this is your own personal app in Testing
mode — that's expected, not an error). You'll land back on the page showing
**✓ Google connected**.

No CLI command, no second install — that's the whole flow.

## 3. Test it

Just text your bot something like "what's on my calendar today" or "find emails about the
flight" — no task to create first, any real question about your Gmail/Calendar works. You
should get a real reply, not the earlier "Gmail/Calendar isn't connected yet" reply.
