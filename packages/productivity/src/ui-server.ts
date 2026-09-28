import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Clock } from "@wappy_ai/core";
import { TASK_TEMPLATES, templateById, type TemplateId } from "./templates.js";
import type { NewTask, TaskStore } from "./store.js";

/**
 * Phase 4: the local task-management page — a single static, mobile-friendly HTML+vanilla-JS page
 * plus a small JSON API, served over plain `node:http` (matching `@wappy_ai/whatsapp`'s
 * `webhook-server.ts` convention: no Express, no new heavy dependency). A single-operator admin
 * page, not a per-contact login flow (see `store.ts`'s `listAll()`) — shows every task across every
 * contact on one page, which is the right shape for this project's current single-operator scope.
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

/** Builds a `title` string from a template + its placeholders — same rendering a generated project's
 * own code would use, kept here so the UI's "created via the API" tasks read the same as any other. */
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
          if (!isNonEmptyString(body.contactId) || !isNonEmptyString(body.templateId) || !isNonEmptyString(body.scheduleKind) || !isNonEmptyString(body.scheduleValue)) {
            sendJson(res, 400, { error: "contactId, templateId, scheduleKind, and scheduleValue are required" });
            return;
          }
          const placeholders = (body.placeholders && typeof body.placeholders === "object" ? body.placeholders : {}) as Record<string, string>;
          const task = await store.create(
            {
              contactId: body.contactId,
              templateId: body.templateId as TemplateId,
              title: renderTitle(body.templateId as TemplateId, placeholders),
              placeholders,
              scheduleKind: body.scheduleKind as NewTask["scheduleKind"],
              scheduleValue: body.scheduleValue,
            },
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
            if (isNonEmptyString(body.status)) {
              await store.setStatus(id, body.status as "on" | "off", clock.now());
            } else {
              const patch: Record<string, unknown> = {};
              if (body.placeholders) patch.placeholders = body.placeholders;
              if (isNonEmptyString(body.scheduleKind as string)) patch.scheduleKind = body.scheduleKind;
              if (isNonEmptyString(body.scheduleValue as string)) patch.scheduleValue = body.scheduleValue;
              await store.update(id, patch, clock.now());
            }
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

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Tasks</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 16px; background: #f5f5f7; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #f2f2f7; } .card { background: #1c1c1e !important; } input, select { background: #2c2c2e !important; color: #f2f2f7 !important; border-color: #3a3a3c !important; } }
  h1 { font-size: 20px; text-align: center; margin: 8px 0 2px; }
  .sub { text-align: center; color: #888; font-size: 13px; margin-bottom: 16px; }
  .card { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .card-title { font-weight: 600; font-size: 15px; }
  .contact { color: #888; font-size: 12px; }
  .warn { color: #b45309; font-size: 12px; margin-top: 6px; }
  input, select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #d1d1d6; font-size: 14px; margin-bottom: 6px; }
  .toggle { border: none; border-radius: 999px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .toggle.on { background: #34c759; color: #fff; }
  .toggle.off { background: #e5e5ea; color: #555; }
  .templates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .template-btn { padding: 12px; border-radius: 10px; border: 1px dashed #c7c7cc; background: transparent; text-align: center; font-size: 13px; cursor: pointer; }
  .row { display: flex; gap: 6px; }
  .row > * { flex: 1; }
  .del { color: #ff3b30; background: none; border: none; font-size: 12px; cursor: pointer; padding: 4px; }
  #addContact { margin-bottom: 14px; }
</style>
</head>
<body>
  <h1>📋 Your Tasks</h1>
  <div class="sub" id="summary">loading...</div>

  <div class="card" id="addContact">
    <div class="card-title" style="margin-bottom:6px;">Your WhatsApp number</div>
    <input id="contactId" placeholder="+15551234567" />
  </div>

  <div class="card" id="oauthCard" style="display:none;"></div>

  <div id="taskList"></div>

  <div class="card">
    <div class="card-title" style="margin-bottom:8px;">Start from a template</div>
    <div class="templates" id="templateList"></div>
  </div>

<script>
const state = { tasks: [], templates: [] };

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

function templateFor(id) { return state.templates.find((t) => t.id === id); }

function renderTasks() {
  const list = document.getElementById("taskList");
  list.innerHTML = "";
  const active = state.tasks.filter((t) => t.status === "on").length;
  document.getElementById("summary").textContent = state.tasks.length + " task(s) · " + active + " active";

  for (const task of state.tasks) {
    const template = templateFor(task.templateId);
    const card = document.createElement("div");
    card.className = "card";

    const top = document.createElement("div");
    top.className = "card-top";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = (template ? template.icon + " " : "") + task.title;
    const toggle = document.createElement("button");
    toggle.className = "toggle " + (task.status === "on" ? "on" : "off");
    toggle.textContent = task.status === "on" ? "On" : "Off";
    toggle.onclick = async () => {
      await api("/api/tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status: task.status === "on" ? "off" : "on" }) });
      await refresh();
    };
    top.append(title, toggle);
    card.appendChild(top);

    const contact = document.createElement("div");
    contact.className = "contact";
    contact.textContent = task.contactId + " · at " + task.scheduleValue + (task.scheduleKind === "once" ? "" : " daily");
    card.appendChild(contact);

    if (template && template.requiresGoogle) {
      const warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = "⚠ Needs Google connected to send real data";
      card.appendChild(warn);
    }

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "Delete";
    del.onclick = async () => {
      await api("/api/tasks/" + task.id, { method: "DELETE" });
      await refresh();
    };
    card.appendChild(del);

    list.appendChild(card);
  }
}

function renderTemplates() {
  const grid = document.getElementById("templateList");
  grid.innerHTML = "";
  for (const template of state.templates) {
    const btn = document.createElement("button");
    btn.className = "template-btn";
    btn.textContent = template.icon + " " + template.label;
    btn.onclick = () => addFromTemplate(template);
    grid.appendChild(btn);
  }
}

async function addFromTemplate(template) {
  const contactId = document.getElementById("contactId").value.trim();
  if (!contactId) { alert("Enter your WhatsApp number first."); return; }
  const placeholders = {};
  for (const field of template.placeholders) {
    const value = prompt(field.label + (field.kind === "time" ? " (HH:MM)" : ""));
    if (value === null) return;
    placeholders[field.key] = value;
  }
  const time = placeholders.time;
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      contactId,
      templateId: template.id,
      placeholders,
      scheduleKind: template.defaultScheduleKind,
      scheduleValue: time || new Date().toISOString(),
    }),
  });
  await refresh();
}

async function refresh() {
  state.tasks = await api("/api/tasks");
  renderTasks();
}

async function refreshOauth() {
  const status = await api("/api/oauth-status");
  const card = document.getElementById("oauthCard");
  if (!status.available) {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";
  card.innerHTML = "";
  if (status.connected) {
    const done = document.createElement("div");
    done.className = "card-title";
    done.textContent = "✓ " + status.label + " connected";
    card.appendChild(done);
  } else {
    const btn = document.createElement("button");
    btn.className = "template-btn";
    btn.style.width = "100%";
    btn.textContent = "Connect " + status.label;
    btn.onclick = () => { window.location.href = status.authUrl; };
    card.appendChild(btn);
  }
}

(async function init() {
  loadContactId();
  state.templates = await api("/api/templates");
  renderTemplates();
  await refresh();
  await refreshOauth();
})();
</script>
</body>
</html>`;
