import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Clock } from "@wappy_ai/core";
import { TASK_TEMPLATES, templateById, type TemplateId } from "./templates.js";
import type { NewTask, TaskStore } from "./store.js";

/**
 * The local task-management page — a single static, mobile-friendly HTML+vanilla-JS page plus a
 * small JSON API, served over plain `node:http` (matching `@wappy_ai/whatsapp`'s
 * `webhook-server.ts` convention: no Express, no new heavy dependency). A single-operator admin
 * page, not a per-contact login flow (see `store.ts`'s `listAll()`) — shows every task across every
 * contact on one page, which is the right shape for this project's current single-operator scope.
 *
 * v2: no scheduling fields anywhere here (`store.ts` dropped them) — a task is created or deleted,
 * nothing to toggle on/off, no run history to show. It's matched reactively by `router.ts` when the
 * contact texts the bot; this page is purely for authoring the filter placeholder and connecting
 * Google, not for watching anything run.
 */

/**
 * A generic "connect a third-party account from this page" plug-in point — deliberately NOT named
 * or shaped after Google specifically, so this package stays domain-agnostic (it doesn't know what
 * Google or any vendor is, matching every other extension point here). A connector package (e.g.
 * `@wappy_ai/connector-google`) builds a real implementation; a generated project's `index.ts`
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

export interface CreateTaskUiServerOptions {
  store: TaskStore;
  clock: Clock;
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Builds a `title` string from a template + its placeholder — same rendering a generated project's
 * own code would use, kept here so tasks created via the API read the same as any other. */
function renderTitle(templateId: TemplateId, placeholders: Record<string, string>): string {
  const template = templateById(templateId);
  const parts = template.placeholders.map((p) => placeholders[p.key]).filter(isNonEmptyString);
  return parts.length > 0 ? `${template.label} ${parts.join(" ")}` : template.label;
}

export function createTaskUiServer(opts: CreateTaskUiServerOptions): Server {
  const { store, clock, oauthConnect } = opts;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url as string, "http://localhost");

      try {
        if (req.method === "GET" && url.pathname === "/") {
          sendHtml(res, PAGE_HTML);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/templates") {
          sendJson(res, 200, TASK_TEMPLATES);
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

        if (req.method === "GET" && url.pathname === "/api/tasks") {
          sendJson(res, 200, await store.listAll());
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/tasks") {
          const body = (await readJsonBody(req)) as Partial<NewTask>;
          if (!isNonEmptyString(body.contactId) || !isNonEmptyString(body.templateId)) {
            sendJson(res, 400, { error: "contactId and templateId are required" });
            return;
          }
          const placeholders = (body.placeholders && typeof body.placeholders === "object" ? body.placeholders : {}) as Record<string, string>;
          const task = await store.create(
            { contactId: body.contactId, templateId: body.templateId as TemplateId, title: renderTitle(body.templateId as TemplateId, placeholders), placeholders },
            clock.now(),
          );
          sendJson(res, 201, task);
          return;
        }

        const taskIdMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
        if (taskIdMatch) {
          const id = taskIdMatch[1]!;
          if (req.method === "PATCH") {
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            if (body.placeholders) patch.placeholders = body.placeholders;
            if (isNonEmptyString(body.title as string)) patch.title = body.title;
            await store.update(id, patch, clock.now());
            sendJson(res, 200, { ok: true });
            return;
          }
          if (req.method === "DELETE") {
            await store.delete(id);
            sendJson(res, 200, { ok: true });
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
 * shadows that collapse on press, saturated neon accent colors. Inline, fill-in-the-blank sentence
 * editing: each template's \`sentence\` (templates.ts) renders as a real, always-visible input
 * embedded in the text, never a popup \`prompt()\`.
 *
 * v2: ONE unified list, same as before, but no more scheduling — every template shows its real
 * tasks (editable inline, copy/delete) plus, when it makes sense to add another (\`repeatable: true\`,
 * or \`repeatable: false\` with none yet), a dashed draft card with an explicit "+ Add" button — a
 * draft is local-only until that button is tapped, so accepting every default (leaving the one
 * filter blank) is one tap, not an accidental side effect of focusing then blurring a field.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Tasks</title>
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
  .panel-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 8px; }

  input[type=text] {
    background: var(--bg); border: 2px solid var(--ink); color: var(--ink); font: inherit; font-weight: 800;
    padding: 4px 8px; border-radius: 4px; outline: none;
  }
  input[type=text]:focus { border-color: var(--pink); background: #fff; }
  #contactId { width: 100%; }

  .task-card.c0 { border-color: var(--pink); box-shadow: 5px 5px 0 var(--pink); }
  .task-card.c1 { border-color: var(--cyan); box-shadow: 5px 5px 0 var(--cyan); }
  .task-card.c2 { border-color: var(--lime); box-shadow: 5px 5px 0 var(--lime); }
  .task-card.c3 { border-color: var(--yellow); box-shadow: 5px 5px 0 var(--yellow); }
  .task-card.c4 { border-color: var(--orange); box-shadow: 5px 5px 0 var(--orange); }
  .task-card.draft { border-style: dashed; box-shadow: 5px 5px 0 rgba(0,0,0,.15); opacity: .9; }
  .task-icon { font-size: 20px; margin-bottom: 4px; }
  .draft-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 6px; }

  .sentence { font-size: 15px; font-weight: 700; line-height: 2.2; }
  .sentence input[type=text] { min-width: 110px; width: auto; }

  .task-meta { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; margin-top: 8px; }
  .warn { color: var(--orange); font-size: 11px; font-weight: 800; text-transform: uppercase; margin-top: 6px; }

  .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }

  .btn3d {
    border: 3px solid #000; font-weight: 900; font-size: 12px; text-transform: uppercase;
    padding: 7px 12px; border-radius: 5px; cursor: pointer; box-shadow: 3px 3px 0 #000;
    transition: transform .06s ease, box-shadow .06s ease; background: var(--lime); color: #000;
  }
  .btn3d:active { transform: translate(3px, 3px); box-shadow: 0 0 0 #000; }
  .btn3d.copy { background: var(--cyan); color: #fff; }
  .btn3d.del { background: var(--pink); color: #fff; }
  .btn3d.add { background: var(--lime); }
  .btn3d.oauth { width: 100%; text-align: center; background: var(--yellow); }

  .oauth-done { font-weight: 900; text-transform: uppercase; color: var(--lime); text-align: center; padding: 4px 0; }
</style>
</head>
<body>
  <h1>📋 Your Tasks</h1>
  <div class="sub" id="summary">loading...</div>

  <div class="panel">
    <div class="panel-label">Your WhatsApp number</div>
    <input type="text" id="contactId" placeholder="+15551234567" />
  </div>

  <div class="panel" id="oauthCard" style="display:none;"></div>

  <div id="taskList"></div>

<script>
const ACCENTS = ["c0", "c1", "c2", "c3", "c4"];
const state = { tasks: [], templates: [], googleConnected: false };

function loadContactId() {
  const saved = localStorage.getItem("wappy-contact-id");
  if (saved) document.getElementById("contactId").value = saved;
}
document.getElementById("contactId").addEventListener("change", (e) => {
  localStorage.setItem("wappy-contact-id", e.target.value);
});

async function api(path, opts) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 200 || res.status === 201 ? res.json() : undefined;
}

/** Renders a template's \`sentence\` ("Find emails about {query}") as real text nodes interleaved
 * with a real <input> at its one {key} — the fill-in-the-blank, always-editable line. */
function buildSentence(template, placeholders, onFieldChange) {
  const wrap = document.createElement("div");
  wrap.className = "sentence";
  for (const part of template.sentence.split(/(\\{\\w+\\})/g)) {
    const m = /^\\{(\\w+)\\}$/.exec(part);
    if (!m) { wrap.appendChild(document.createTextNode(part)); continue; }
    const key = m[1];
    const field = template.placeholders.find((p) => p.key === key);
    const input = document.createElement("input");
    input.type = "text";
    input.value = placeholders[key] || "";
    input.placeholder = field ? field.placeholderHint : key;
    input.onchange = () => onFieldChange(key, input.value);
    wrap.appendChild(input);
  }
  return wrap;
}

function connectorLabel(template) {
  return template.connector === "gmail" ? "Gmail" : "Calendar";
}

/** A real, already-created task — sentence, meta, copy/delete. No toggle, no run status: a task
 * either exists (and router.ts may match it against an inbound message) or it's deleted. */
function buildTaskCard(template, task, accentClass) {
  const card = document.createElement("div");
  card.className = "panel task-card " + accentClass;

  const icon = document.createElement("div");
  icon.className = "task-icon";
  icon.textContent = template.icon;
  card.appendChild(icon);

  card.appendChild(buildSentence(template, task.placeholders, async (key, value) => {
    const placeholders = { ...task.placeholders, [key]: value };
    await api("/api/tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ placeholders }) });
    await refresh();
  }));

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.textContent = task.contactId;
  card.appendChild(meta);

  if (!state.googleConnected) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = "\\u26a0 Needs " + connectorLabel(template) + " connected";
    card.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn3d copy";
  copyBtn.textContent = "Copy";
  copyBtn.onclick = async () => {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ contactId: task.contactId, templateId: task.templateId, placeholders: task.placeholders }),
    });
    await refresh();
  };
  actions.appendChild(copyBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "btn3d del";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    await api("/api/tasks/" + task.id, { method: "DELETE" });
    await refresh();
  };
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

/** Not created yet — dashed outline, local-only until "+ Add" is tapped, so accepting every default
 * (leaving the one filter blank) is a deliberate single tap, not a side effect of focus/blur. */
function buildDraftCard(template) {
  const card = document.createElement("div");
  card.className = "panel task-card draft";

  const label = document.createElement("div");
  label.className = "draft-label";
  label.textContent = "+ Add";
  card.appendChild(label);

  const icon = document.createElement("div");
  icon.className = "task-icon";
  icon.textContent = template.icon;
  card.appendChild(icon);

  const draft = {};
  for (const f of template.placeholders) draft[f.key] = "";
  card.appendChild(buildSentence(template, draft, (key, value) => { draft[key] = value; }));

  if (!state.googleConnected) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = "\\u26a0 Needs " + connectorLabel(template) + " connected";
    card.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const addBtn = document.createElement("button");
  addBtn.className = "btn3d add";
  addBtn.textContent = "+ Add";
  addBtn.onclick = async () => {
    const contactId = document.getElementById("contactId").value.trim();
    if (!contactId) { alert("Enter your WhatsApp number first."); return; }
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ contactId, templateId: template.id, placeholders: draft }) });
    await refresh();
  };
  actions.appendChild(addBtn);
  card.appendChild(actions);

  return card;
}

/** One unified list: for each template, its real tasks (in creation order), then — if repeatable, or
 * if not repeatable and none exists yet — exactly one trailing draft slot. No separate "pick a
 * template" section anywhere on the page. */
function renderList() {
  const list = document.getElementById("taskList");
  list.innerHTML = "";
  document.getElementById("summary").textContent = state.tasks.length + " task(s)";

  let accentIndex = 0;
  for (const template of state.templates) {
    const existing = state.tasks.filter((t) => t.templateId === template.id);
    for (const task of existing) {
      list.appendChild(buildTaskCard(template, task, ACCENTS[accentIndex % ACCENTS.length]));
      accentIndex++;
    }
    if (template.repeatable || existing.length === 0) {
      list.appendChild(buildDraftCard(template));
    }
  }
}

async function refresh() {
  state.tasks = await api("/api/tasks");
  renderList();
}

async function refreshOauth() {
  const status = await api("/api/oauth-status");
  state.googleConnected = Boolean(status.connected);
  const card = document.getElementById("oauthCard");
  if (!status.available) { card.style.display = "none"; return; }
  card.style.display = "block";
  card.innerHTML = "";
  if (status.connected) {
    const done = document.createElement("div");
    done.className = "oauth-done";
    done.textContent = "\\u2713 " + status.label + " connected";
    card.appendChild(done);
  } else {
    const btn = document.createElement("button");
    btn.className = "btn3d oauth";
    btn.textContent = "Connect " + status.label;
    btn.onclick = () => { window.location.href = status.authUrl; };
    card.appendChild(btn);
  }
}

(async function init() {
  loadContactId();
  state.templates = await api("/api/templates");
  await refreshOauth();
  await refresh();
})();
</script>
</body>
</html>`;
