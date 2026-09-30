import { createServer, type Server, type ServerResponse } from "node:http";

/**
 * v3 redesign — the local "connect Google" page. Everything task-related (the 4 fixed templates, the
 * per-contact task store, the inline fill-in-the-blank sentence UI) is gone: `assistant.ts`'s
 * `createGoogleAssistant` answers ANY Gmail/Calendar question reactively, no saved task required, so
 * there's nothing left to author or list here. This page's only job now is the one real manual step
 * that can't be automated away — connecting your own Google account — served over plain `node:http`
 * (matching `@wappy_ai/whatsapp`'s `webhook-server.ts` convention: no Express, no new dependency).
 */

/**
 * A generic "connect a third-party account from this page" plug-in point — deliberately NOT named
 * or shaped after Google specifically, so this package stays domain-agnostic. A connector package
 * (e.g. `@wappy_ai/connector-google`) builds a real implementation; a generated project's `index.ts`
 * (orchestration code, allowed to wire multiple parts together) passes it in here — this file never
 * imports anything connector-specific itself.
 */
export interface OAuthConnectPlugin {
  /** Card label, e.g. "Google". */
  label: string;
  /** Whether the "Connect X" card should show at all (e.g. credentials are configured). */
  isAvailable(): Promise<boolean> | boolean;
  /** Whether already connected — shows "✓ X connected" instead of the connect card. */
  isConnected(): Promise<boolean> | boolean;
  /** The URL to send the browser to when "Connect" is tapped. */
  authUrl(): string;
  /** The path this plugin's own callback route is mounted at, e.g. "/google/callback". */
  callbackPath: string;
  /** Handles the callback request (parse the code, exchange it, store the result). Return `true` if
   * this request was actually the plugin's callback (the server redirects back to "/"); `false` to
   * fall through to a normal 404. */
  handleCallback(url: URL): Promise<boolean>;
}

export interface CreateConnectUiServerOptions {
  port?: number;
  oauthConnect?: OAuthConnectPlugin;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Plain `node:http` server serving the connect page + its small JSON status API + the oauth
 * plugin's own callback route. */
export function createConnectUiServer(opts: CreateConnectUiServerOptions): Server {
  const { oauthConnect } = opts;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url as string, "http://localhost");

      try {
        if (req.method === "GET" && url.pathname === "/") {
          sendHtml(res, PAGE_HTML);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/oauth-status") {
          if (!oauthConnect) {
            sendJson(res, 200, { available: false, connected: false, label: null, authUrl: null });
            return;
          }
          sendJson(res, 200, {
            available: await oauthConnect.isAvailable(),
            connected: await oauthConnect.isConnected(),
            label: oauthConnect.label,
            authUrl: oauthConnect.authUrl(),
          });
          return;
        }

        if (oauthConnect && url.pathname === oauthConnect.callbackPath) {
          const handled = await oauthConnect.handleCallback(url);
          if (handled) {
            res.writeHead(302, { location: "/" });
            res.end();
            return;
          }
        }

        sendJson(res, 404, { error: "not found" });
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

/**
 * Neobrutalist/neon design on a light (cream/white) canvas — thick black borders, hard offset "3D"
 * shadows, saturated neon accents — carried over unchanged from the task-list page's own styling.
 * Content is now just: what this connects, what it can/can't do (read-only, no CRUD — stated plainly
 * and warmly, with an open-source invitation rather than a bare refusal), and the connect button.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Google</title>
<style>
  :root {
    --bg: #faf3e6;
    --panel: #fffdf7;
    --ink: #16151a;
    --pink: #ff2fd0;
    --cyan: #00b8c4;
    --lime: #8fb800;
    --yellow: #e6a600;
    --orange: #ff6a1a;
    --muted: #6b6a72;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--ink);
    max-width: 480px;
    margin: 0 auto;
    padding: 16px 16px 40px;
  }
  h1 {
    font-size: 26px;
    font-weight: 900;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 10px 0 2px;
    text-shadow: 3px 3px 0 var(--pink);
  }
  .sub { text-align: center; color: var(--pink); font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 18px; }

  .panel { background: var(--panel); border: 3px solid #000; border-radius: 6px; padding: 14px; margin-bottom: 14px; box-shadow: 5px 5px 0 #000; }
  .panel.c0 { border-color: var(--cyan); box-shadow: 5px 5px 0 var(--cyan); }
  .panel.c1 { border-color: var(--lime); box-shadow: 5px 5px 0 var(--lime); }
  .panel-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 8px; }
  .panel p { margin: 0; line-height: 1.5; font-size: 14px; }
  .panel p + p { margin-top: 8px; }
  .example { font-weight: 800; }
  .muted-note { color: var(--muted); font-size: 12px; margin-top: 8px; }

  .btn3d {
    border: 3px solid #000; font-weight: 900; font-size: 12px; text-transform: uppercase;
    padding: 10px 12px; border-radius: 5px; cursor: pointer; box-shadow: 3px 3px 0 #000;
    transition: transform .06s ease, box-shadow .06s ease; background: var(--yellow); color: #000;
    width: 100%; text-align: center;
  }
  .btn3d:active { transform: translate(3px, 3px); box-shadow: 0 0 0 #000; }

  .oauth-done { font-weight: 900; text-transform: uppercase; color: var(--lime); text-align: center; padding: 4px 0; }
  .oauth-unavailable { color: var(--muted); font-size: 13px; text-align: center; }
</style>
</head>
<body>
  <h1>🔌 Connect Google</h1>
  <div class="sub" id="summary">loading...</div>

  <div class="panel c0">
    <div class="panel-label">What this does</div>
    <p>Once connected, just text your bot things like <span class="example">"what's on my calendar today"</span> or <span class="example">"find emails about the flight"</span> — no setup beyond this page, no saved tasks to create first.</p>
  </div>

  <div class="panel c1">
    <div class="panel-label">Read-only</div>
    <p>This can only read your Gmail and Calendar — it can't send an email or create, edit, or delete anything.</p>
    <p class="muted-note">This is free, open-source software — if a write capability like that is something you want, contributions are very welcome.</p>
  </div>

  <div class="panel" id="oauthCard"></div>

<script>
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function refreshOauth() {
  const status = await api("/api/oauth-status");
  const card = document.getElementById("oauthCard");
  const summary = document.getElementById("summary");
  if (!status.available) {
    summary.textContent = "not set up";
    card.innerHTML = "";
    const note = document.createElement("div");
    note.className = "oauth-unavailable";
    note.textContent = "Add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to .env first — see GOOGLE_SETUP.md.";
    card.appendChild(note);
    return;
  }
  card.innerHTML = "";
  if (status.connected) {
    summary.textContent = "connected";
    const done = document.createElement("div");
    done.className = "oauth-done";
    done.textContent = "\\u2713 " + status.label + " connected";
    card.appendChild(done);
  } else {
    summary.textContent = "not connected yet";
    const btn = document.createElement("button");
    btn.className = "btn3d";
    btn.textContent = "Connect " + status.label;
    btn.onclick = () => { window.location.href = status.authUrl; };
    card.appendChild(btn);
  }
}

refreshOauth();
</script>
</body>
</html>`;
