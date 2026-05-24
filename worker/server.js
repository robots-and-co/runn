'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const bridge = require('./bridge');
const queue = require('./queue');
const migrateClients = require('./migrate-clients');
const migratePaths = require('./migrate-paths');
const migrateCwdCollapse = require('./migrate-cwd-collapse');
const { applyTimerTransition } = require('./timer');

// ── Config ───────────────────────────────────────────────────
const HOME = process.env.HOME;
const DATA_ROOT = path.join(HOME, 'runn-data');
const CARDS_DIR = path.join(DATA_ROOT, 'cards');
const ARCHIVE_DIR = path.join(CARDS_DIR, 'archive');
const TAGS_DIR = path.join(DATA_ROOT, 'tags');
const CLIENTS_DIR = path.join(DATA_ROOT, 'clients');
const INVOICES_DIR = path.join(DATA_ROOT, 'invoices');
const ASSETS_DIR = path.join(DATA_ROOT, 'assets');
const SETTINGS_PATH = path.join(DATA_ROOT, 'settings.json');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const WORKSPACES_ROOT = path.join(HOME, 'projects');
const PORT = Number(process.env.PORT || 17777);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const cardPath = (id) => path.join(CARDS_DIR, `${id}.json`);
const archivePath = (id) => path.join(ARCHIVE_DIR, `${id}.json`);
// Some flows (invoice void, historical invoice reads) need to find a card by
// id without caring whether it's been archived. Returns { card, archived, path }
// or null if neither location has it.
async function cardReadAnywhere(id) {
  const live = cardPath(id);
  try { return { card: await readJson(live), archived: false, path: live }; } catch {}
  const arch = archivePath(id);
  try { return { card: await readJson(arch), archived: true,  path: arch  }; } catch {}
  return null;
}
const tagPath = (name) => path.join(TAGS_DIR, `${name}.json`);
const clientPath = (id) => path.join(CLIENTS_DIR, `${id}.json`);
const invoicePath = (id) => path.join(INVOICES_DIR, `${id}.json`);
const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'));
const readJsonOr = async (p, fallback) => {
  try { return await readJson(p); } catch { return fallback; }
};

async function atomicWriteJson(p, data) {
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
}

// ── Invoicing defaults + helpers ─────────────────────────────
const DEFAULT_SETTINGS = {
  business_name: '',
  business_address_lines: [],
  business_abn_acn: '',
  logo_path: '/assets/logo.png',
  currency: 'AUD',
  currency_symbol: '$',
  default_gst_rate: 0.10,
  default_due_days: 14,
  default_rate_per_hour: null,
  date_format: 'DD/MM/YYYY',
  bank: { bank: '', name: '', bsb: '', acc: '' },
  // Default workspace slug for cards with no client (personal projects).
  // Cards spawn into ~/projects/<personal_workspace>/.
  personal_workspace: 'waz',
};

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function round2(n) { return Math.round(n * 100) / 100; }

async function createInvoice(body) {
  // body: { client_id, items: [{card_id, description, date, amount_ex_gst}], notes?, due_at?, issued_at? }
  if (!body.client_id) throw new Error('client_id required');
  if (!Array.isArray(body.items) || !body.items.length) throw new Error('items required');

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  const client = await readJson(clientPath(body.client_id));

  // Mint id: {prefix}{seq}, bump seq, persist back to client file
  const prefix = (client.invoice_prefix || (client.name || 'INV')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const seq = Number.isFinite(client.invoice_seq) ? client.invoice_seq : 1;
  const id = `${prefix}${seq}`;
  const updatedClient = { ...client, invoice_prefix: prefix, invoice_seq: seq + 1, updated_at: nowIso() };
  await atomicWriteJson(clientPath(body.client_id), updatedClient);

  const items = body.items.map(it => ({
    card_id:        it.card_id || null,
    description:    it.description || '',
    date:           it.date || todayISO(),
    amount_ex_gst:  round2(Number(it.amount_ex_gst) || 0),
  }));
  const subtotal = round2(items.reduce((s, it) => s + it.amount_ex_gst, 0));
  const gstRate  = (typeof body.gst_rate === 'number') ? body.gst_rate
                 : (typeof client.gst_rate === 'number') ? client.gst_rate
                 : (settings.default_gst_rate || 0);
  const gst      = round2(subtotal * gstRate);
  const total    = round2(subtotal + gst);

  const issued = body.issued_at || todayISO();
  const due    = body.due_at    || addDays(issued, settings.default_due_days || 14);

  const inv = {
    id,
    client_id: body.client_id,
    issued_at: issued,
    due_at: due,
    items,
    subtotal_ex_gst: subtotal,
    gst_rate: gstRate,
    gst,
    total_inc_gst: total,
    paid: 0,
    balance: total,
    status: 'draft',
    notes: body.notes || '',
    snapshot: {
      from: {
        name: settings.business_name || '',
        address_lines: settings.business_address_lines || [],
        abn_acn: settings.business_abn_acn || '',
        logo_path: settings.logo_path || '',
      },
      to: {
        company: client.company || client.name || '',
        contact: client.contact || '',
        address_lines: client.address_lines || [],
        abn: client.abn || '',
      },
      bank: settings.bank || { bank: '', name: '', bsb: '', acc: '' },
      currency: client.currency || settings.currency || 'AUD',
      currency_symbol: settings.currency_symbol || '$',
      date_format: settings.date_format || 'DD/MM/YYYY',
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await atomicWriteJson(invoicePath(id), inv);
  console.log(`[runn] issued invoice ${id} (${items.length} items, ${settings.currency_symbol || '$'}${total})`);
  return inv;
}

// ── Card store ───────────────────────────────────────────────
async function listCards() {
  const files = await fsp.readdir(CARDS_DIR);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try { out.push(await readJson(path.join(CARDS_DIR, f))); } catch {}
  }
  out.sort((a, b) => a.sort_order - b.sort_order);
  return out;
}

// Walk a card's parent chain looking for the nearest `location` field.
// Projects own the working dir; tasks inherit it. Stops at the first hit and
// falls back to bridge.DEFAULT_LOCATION at the top if nothing's set.
async function resolveCardLocation(card) {
  // Externally-adopted sessions stay anchored to wherever they were spawned —
  // their cwd is encoded in session_path, not derived from Runn's domain model.
  if (card && card.origin === 'external') {
    const loc = locationFromSessionPath(card.session_path);
    if (loc) return loc;
  }
  // Walk to the root (project card) to find the client_id — tasks inherit.
  let c = card, n = 0;
  while (c && c.parent_id && n++ < 16) {
    try { c = await readJson(cardPath(c.parent_id)); } catch { c = null; break; }
  }
  // Client-bound project → ~/projects/<client.workspace>
  if (c && c.client_id) {
    try {
      const client = await readJson(clientPath(c.client_id));
      if (client.workspace) return { type: 'local', cwd: path.join(WORKSPACES_ROOT, client.workspace) };
    } catch {}
  }
  // Personal project (no client) → ~/projects/<settings.personal_workspace>
  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  const slug = settings.personal_workspace || DEFAULT_SETTINGS.personal_workspace;
  return { type: 'local', cwd: path.join(WORKSPACES_ROOT, slug) };
}

// Same shape as resolveCardLocation but for the permission mode. Returns one
// of 'default' | 'acceptEdits' | 'bypassPermissions'. Tasks inherit from their
// project; absent → 'default' (every tool prompts via the MCP bridge).
async function resolveCardPermissionMode(card) {
  let c = card;
  for (let i = 0; i < 8 && c; i++) {
    if (c.permission_mode) return c.permission_mode;
    if (!c.parent_id) break;
    try { c = await readJson(cardPath(c.parent_id)); } catch { break; }
  }
  return 'default';
}

// Build the system-prompt context appended to a spawn. Walks the parent chain
// to find the project (top-most ancestor), pulls notes_md off it (project
// context) and off its linked client (client context). Returns a single string
// or null. Order is client first (broader background), then project (specific
// scope) — both fenced so the AI sees them as reference material, not turn 1.
async function resolveCardSystemContext(card) {
  let project = card;
  for (let i = 0; i < 8 && project; i++) {
    if (!project.parent_id) break;
    try { project = await readJson(cardPath(project.parent_id)); } catch { project = null; break; }
  }
  const parts = [];
  if (project && project.client_id) {
    try {
      const client = await readJson(clientPath(project.client_id));
      if (client.notes_md && String(client.notes_md).trim()) {
        const label = client.name || client.company || client.id;
        parts.push(`# Client context: ${label}\n\n${String(client.notes_md).trim()}`);
      }
    } catch { /* missing client file — skip */ }
  }
  // Only include the project's notes_md as system context if it's a different
  // card than the one being spawned. When the project itself is being ai-ified,
  // its notes_md is already in turn 1 via bridge's title+notes concat.
  if (project && project.id !== card.id && project.notes_md && String(project.notes_md).trim()) {
    const label = project.title || project.id;
    parts.push(`# Project context: ${label}\n\n${String(project.notes_md).trim()}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Archived cards live in cards/archive/. The fs watcher ignores that dir, so
// changes here don't push WS events — clients refetch when the user toggles
// "show archived" on.
async function listArchived() {
  const out = [];
  try {
    const files = await fsp.readdir(ARCHIVE_DIR);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const c = await readJson(path.join(ARCHIVE_DIR, f));
        c._archived = true;
        out.push(c);
      } catch {}
    }
  } catch {}
  out.sort((a, b) => a.sort_order - b.sort_order);
  return out;
}

function nowIso() { return new Date().toISOString(); }
function mintCardId(seed) {
  if (seed) return `c_${seed.slice(0, 8)}`;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
}

// ── Workspace helpers (per-client folder under ~/projects) ──
// A workspace is just a directory under $HOME/projects. Clients have a
// default workspace slug; tasks may override per-task. Picking is constrained
// to this tree (no arbitrary host paths) — this is also the first structural
// step toward per-client access scoping. See HANDOFF.md "WORKSPACE PICKER".
function slugifyName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureWorkspace(name, fallbackId) {
  // Idempotent. mkdir -p ~/projects/<slug>; seed a stub CLAUDE.md only if
  // the dir is brand new (empty). Never overwrite an existing CLAUDE.md, and
  // never drop a stub into a dir that already has real content (e.g. an
  // existing repo whose name happened to collide with a new client slug).
  // Returns the slug used.
  const slug = slugifyName(name) || fallbackId;
  const dir = path.join(WORKSPACES_ROOT, slug);
  await fsp.mkdir(dir, { recursive: true });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  try { await fsp.access(claudeMd); return slug; } catch {} // exists, done
  const entries = await fsp.readdir(dir).catch(() => []);
  if (entries.length === 0) {
    await fsp.writeFile(
      claudeMd,
      `# ${name || slug} — workspace stub\n\nInherits context from ../CLAUDE.md.\n`
    );
  }
  return slug;
}

// ── Claude session helpers ───────────────────────────────────
// Path: ~/.claude/projects/<slug>/<uuid>.jsonl
const SESSION_PATH_RE = /\/\.claude\/projects\/([^/]+)\/([0-9a-f-]{36})\.jsonl$/;

function sessionIdFromPath(p) {
  const m = p.match(SESSION_PATH_RE);
  return m ? m[2] : null;
}

function slugToLabel(slug) {
  // -home-waz-projects-runn → "runn" (last hyphen segment is good enough)
  const noLead = slug.replace(/^-/, '');
  const parts = noLead.split('-');
  return parts[parts.length - 1] || slug;
}

function slugToCwd(slug) {
  // -home-waz-projects-runn → /home/waz/projects/runn
  return '/' + slug.replace(/^-/, '').replace(/-/g, '/');
}

// Derive a {type:'local', cwd} location from a session_path, falling back gracefully.
function locationFromSessionPath(sessionPath) {
  if (!sessionPath) return null;
  const m = sessionPath.match(/\/\.claude\/projects\/([^/]+)\//);
  if (!m) return null;
  return { type: 'local', cwd: slugToCwd(m[1]) };
}

// Stream-read jsonl, return latest user-set title (custom-title from CC Desktop renames),
// falling back to the latest auto-generated ai-title if no rename has happened.
async function readLatestAiTitle(jsonlPath) {
  let aiTitle = null;
  let customTitle = null;
  try {
    const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"ai-title"') && !line.includes('"custom-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'ai-title'     && o.aiTitle)     aiTitle     = o.aiTitle;
        if (o.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      } catch {}
    }
  } catch {}
  return customTitle || aiTitle;
}

function formatAskQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return '';
  const parts = [];
  for (const q of questions) {
    if (!q || !q.question) continue;
    parts.push(`**${q.question}**`);
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (opt && opt.label) parts.push(`- ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
      }
    }
  }
  return parts.join('\n');
}

function formatAskAnswer(toolResultBlock, userEv) {
  const tur = userEv && userEv.toolUseResult;
  const answers = tur && tur.answers;
  if (answers && typeof answers === 'object') {
    const entries = Object.entries(answers);
    if (!entries.length) return '_(no answer — question auto-dismissed)_';
    return entries.map(([q, v]) => {
      let ans;
      if (v == null) ans = '(empty)';
      else if (typeof v === 'string') ans = v;
      else if (Array.isArray(v)) ans = v.join(', ');
      else if (typeof v === 'object') ans = v.answer || v.label || JSON.stringify(v);
      else ans = String(v);
      return `**${q}**\n→ ${ans}`;
    }).join('\n\n');
  }
  if (toolResultBlock && toolResultBlock.is_error) return '_(no answer — question dismissed)_';
  if (toolResultBlock && typeof toolResultBlock.content === 'string') return toolResultBlock.content;
  return '_(no answer)_';
}

// Parse a Claude Code session jsonl into a list of turns suitable for chat-style render.
async function parseTranscript(jsonlPath) {
  const events = [];
  try {
    const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  } catch {}

  const turns = [];
  // One bubble per assistant API response (one message.id). Claude Code writes
  // text/thinking/tool_use blocks of a single response as separate jsonl events
  // that share message.id — those merge. A new message.id starts a new bubble,
  // so each model turn renders chronologically instead of one wall of text.
  // We deliberately drop `thinking` blocks (almost always redacted) and `tool_use` blocks (implementation noise).
  let openAssistant = null;
  let openAssistantId = null;
  const flushAssistant = () => {
    if (!openAssistant) return;
    if (openAssistant.text) turns.push(openAssistant);
    openAssistant = null;
    openAssistantId = null;
  };

  // AskUserQuestion is a real turn boundary: the tool_use carries the
  // question, the paired tool_result carries the answer (or empty answers
  // when Runn auto-dismisses it in -p mode). Without surfacing the pair,
  // the next assistant response merges into the previous one and looks
  // like the AI is answering itself.
  const askIds = new Set();

  const SKIP = new Set(['ai-title', 'queue-operation', 'last-prompt', 'attachment', 'file-history-snapshot', 'permission-mode']);
  for (const ev of events) {
    if (SKIP.has(ev.type)) continue; // metadata — does not break turns
    const ts = ev.timestamp || ev.ts || null;
    if (ev.type === 'assistant') {
      const c = ev.message?.content;
      if (!Array.isArray(c)) continue;
      const msgId = ev.message?.id || null;
      if (openAssistant && msgId && msgId !== openAssistantId) flushAssistant();
      for (const block of c) {
        if (block.type === 'text' && block.text) {
          if (!openAssistant) { openAssistant = { kind: 'assistant', text: '', ts }; openAssistantId = msgId; }
          openAssistant.text = openAssistant.text ? `${openAssistant.text}\n${block.text}` : block.text;
        } else if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id) {
          flushAssistant();
          const qText = formatAskQuestions(block.input && block.input.questions);
          if (qText) turns.push({ kind: 'assistant', text: qText, ts });
          askIds.add(block.id);
        }
        // thinking + other tool_use blocks intentionally ignored
      }
      continue;
    }

    if (ev.type === 'user') {
      const c = ev.message?.content;
      const isPureToolResult = Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result');
      if (isPureToolResult) {
        const askResults = c.filter(b => askIds.has(b.tool_use_id));
        if (askResults.length) {
          flushAssistant();
          for (const r of askResults) {
            const ans = formatAskAnswer(r, ev);
            if (ans) turns.push({ kind: 'user', text: ans, ts });
          }
        }
        continue; // generic tool_results stay paired into the open assistant turn
      }
      flushAssistant();
      if (typeof c === 'string' && c.trim()) {
        turns.push({ kind: 'user', text: c, ts });
      } else if (Array.isArray(c)) {
        const textBlocks = c.filter(b => b.type === 'text' && b.text);
        const userText = textBlocks.map(b => b.text).join('\n').trim();
        if (userText) turns.push({ kind: 'user', text: userText, ts });
      }
      continue;
    }

    flushAssistant();
    if (ev.type === 'system') {
      const text = typeof ev.content === 'string' ? ev.content
                 : ev.message?.content ? (typeof ev.message.content === 'string' ? ev.message.content : '')
                 : '';
      if (text.trim()) turns.push({ kind: 'system', text, ts });
    }
  }
  flushAssistant();

  return { turns, total_events: events.length };
}

// ── HTTP plumbing ────────────────────────────────────────────
function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    // Heuristic browser caching on responses without Cache-Control was masking
    // live transcript updates — polling re-fetched the same stale copy.
    'cache-control': 'no-store, no-cache, must-revalidate',
  });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function ctFor(p) {
  return p.endsWith('.html')      ? 'text/html; charset=utf-8'
       : p.endsWith('.css')       ? 'text/css'
       : p.endsWith('.js')        ? 'application/javascript'
       : p.endsWith('.json')      ? 'application/manifest+json'
       : p.endsWith('.svg')       ? 'image/svg+xml'
       : p.endsWith('.png')       ? 'image/png'
       : p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg'
       : p.endsWith('.webp')      ? 'image/webp'
       : p.endsWith('.webmanifest') ? 'application/manifest+json'
       :                            'application/octet-stream';
}

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  // /assets/* served from ~/runn-data/assets/ (logo etc)
  if (p.startsWith('/assets/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice('/assets/'.length)); }
    catch { res.writeHead(400); res.end('bad url'); return; }
    const full = path.normalize(path.join(ASSETS_DIR, rel));
    if (!full.startsWith(ASSETS_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': ctFor(rel) });
      res.end(data);
    });
    return;
  }
  const full = path.normalize(path.join(FRONTEND_DIR, p));
  if (!full.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback: any extension-less GET path serves index.html so client-side
      // routing (e.g. /invoices/INV-001) works on direct load + browser reload.
      if (!path.extname(p)) {
        fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
          });
          res.end(html);
        });
        return;
      }
      res.writeHead(404); res.end('not found');
      return;
    }
    // Shell files change frequently during dev; never let the browser cache
    // a stale copy. Assets in runn-data/assets/ are unaffected (different code path).
    res.writeHead(200, {
      'content-type': ctFor(p),
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
}

// ── HTTP routes ──────────────────────────────────────────────
// ── Permission bridge state ──────────────────────────────────
// Permission tokens are minted before spawning a Claude session and passed in
// via env so the MCP server can identify which card a request belongs to.
const permissionTokens   = new Map(); // token → card_id
const pendingPermissions = new Map(); // request_id → { send, card_id, tool_name, input, created_at }

function alwaysAllowKey(toolName) { return toolName; }
async function isAlwaysAllowed(toolName) {
  const s = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  return !!(s.permissions && s.permissions.alwaysAllow && s.permissions.alwaysAllow[alwaysAllowKey(toolName)]);
}
async function setAlwaysAllowed(toolName) {
  const s = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  s.permissions = s.permissions || {};
  s.permissions.alwaysAllow = s.permissions.alwaysAllow || {};
  s.permissions.alwaysAllow[alwaysAllowKey(toolName)] = true;
  await atomicWriteJson(SETTINGS_PATH, s);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const m = req.method;
    let mm;

    if (m === 'GET' && url.pathname === '/cards') {
      return sendJson(res, 200, await listCards());
    }
    if (m === 'GET' && url.pathname === '/archive') {
      return sendJson(res, 200, await listArchived());
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/cards\/([^/]+)$/))) {
      return sendJson(res, 200, await readJson(cardPath(mm[1])));
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/transcript$/))) {
      const card = await readJson(cardPath(mm[1]));
      if (!card.session_path) return sendJson(res, 200, { turns: [], total_events: 0 });
      return sendJson(res, 200, await parseTranscript(card.session_path));
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/message$/))) {
      const card = await readJson(cardPath(mm[1]));
      if (!card.session_id) return sendJson(res, 400, { error: 'card has no session_id' });
      const body = await readBody(req);
      if (!body.text || !body.text.trim()) return sendJson(res, 400, { error: 'text required' });
      const location = await resolveCardLocation(card);
      if (!location) return sendJson(res, 400, { error: 'card has no resolvable location' });
      const prevStatus = card.status;
      const text = body.text.trim();
      const permissionToken = crypto.randomUUID();
      permissionTokens.set(permissionToken, card.id);
      const permissionMode = await resolveCardPermissionMode(card);
      // Flip the card to `status` and persist with timer accounting. Re-reads
      // from disk first so we never clobber a concurrent write, and no-ops if
      // it's already there (so a redundant doing→doing won't restart the timer).
      const setStatus = async (status) => {
        const current = await readJson(cardPath(card.id));
        if (current.status === status) return;
        const next = { ...current, status, updated_at: nowIso() };
        applyTimerTransition(current, next, nowIso);
        await atomicWriteJson(cardPath(card.id), next);
      };
      try {
        await bridge.sendMessage({
          sessionId: card.session_id,
          text,
          location,
          permissionToken,
          permissionMode,
          holder: `card:${card.id}`,
          onExit: (code) => {
            queue.handleAiExit(card.id, code, queueDeps).catch(err =>
              console.error('[runn] queue handleAiExit (sendMessage) failed', err));
          },
        });
        // sendMessage resolved on the resume subprocess's init event — the turn
        // is genuinely running now, so stamp `doing`. handleAiExit moves it to
        // `review`/`blocked` when the subprocess exits, marking the turn's end.
        await setStatus('doing');
        return sendJson(res, 202, { ok: true });
      } catch (err) {
        // CWD_BUSY isn't a failure — the cwd is held (typically by this same
        // card's previous turn that hasn't exited yet, or by another project
        // sharing the working tree). Buffer the message; it dispatches when the
        // holder exits and releaseCwd fires. Reflect the wait in the card's
        // status: if it isn't already running its own turn, mark it `waiting`
        // so the UI shows "queued behind something" rather than a stale `doing`.
        if (err && err.code === 'CWD_BUSY') {
          if (prevStatus !== 'doing') {
            await setStatus('waiting').catch(e =>
              console.error('[runn] setStatus(waiting) failed', e));
          }
          const position = bridge.enqueueMessage(card.session_id, {
            text,
            location,
            permissionToken,
            permissionMode,
            holder: `card:${card.id} (queued)`,
            // When the buffered message actually starts, flip waiting → doing.
            onStart: () => {
              setStatus('doing').catch(e =>
                console.error('[runn] queued onStart setStatus(doing) failed', e));
            },
            onExit: (code) => {
              queue.handleAiExit(card.id, code, queueDeps).catch(e =>
                console.error('[runn] queue handleAiExit (queued message) failed', e));
            },
          });
          console.log(`[runn] message ${card.id} queued (position ${position}, cwd busy: ${err.holder})`);
          return sendJson(res, 202, { ok: true, queued: true, queue_position: position });
        }
        console.error('[runn] sendMessage failed', err);
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/interrupt$/))) {
      const card = await readJson(cardPath(mm[1])).catch(() => null);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      if (!card.session_id) return sendJson(res, 400, { error: 'card has no session' });
      // Mark before killing so the exit callback (which fires asynchronously
      // once claude actually dies) lands the card in `review`, not `blocked`.
      // Drop buffered follow-ups first so the kill doesn't immediately respawn.
      interruptedCards.add(card.id);
      const cleared = bridge.clearPending(card.session_id);
      const result = bridge.killSession(card.session_id);
      if (result.ok) {
        console.log(`[runn] interrupt ${card.id}: signalled pid ${result.pid} (cleared ${cleared} queued)`);
        return sendJson(res, 202, { ok: true, cleared });
      }
      // Nothing was actually running for this session — the turn already
      // finished. No exit callback will come, so clear the marker ourselves and
      // reconcile a card that's still showing `doing`/`waiting` (a dead/orphaned
      // turn) down to `review` so the Stop button always clears the spinner
      // rather than dead-ending on an error.
      interruptedCards.delete(card.id);
      const fresh = await readJson(cardPath(card.id)).catch(() => card);
      if (fresh.status === 'doing' || fresh.status === 'waiting') {
        const next = { ...fresh, status: 'review', updated_at: nowIso() };
        applyTimerTransition(fresh, next, nowIso);
        await atomicWriteJson(cardPath(card.id), next);
        // cardsWatcher broadcasts card.changed on the file write.
        console.log(`[runn] interrupt ${card.id}: no live turn; reconciled ${fresh.status} → review`);
        return sendJson(res, 200, { ok: true, reconciled: true, cleared });
      }
      return sendJson(res, 200, { ok: true, reconciled: false, cleared, note: result.reason });
    }
    if (m === 'POST' && url.pathname === '/cards') {
      const body = await readBody(req);
      const id = body.id || mintCardId();
      const card = {
        id,
        // Allow explicit '' so the frontend can create a "fresh" task with no
        // first turn yet and let the user type it in the chat panel.
        title: body.title ?? 'Untitled',
        status: body.status || 'queued',
        parent_id: body.parent_id ?? null,
        sort_order: body.sort_order ?? Date.now(),
        session_id: body.session_id ?? null,
        session_path: body.session_path ?? null,
        origin: body.origin || 'runn',
        notes_md: body.notes_md || '',
        tags: Array.isArray(body.tags) ? body.tags : [],
        hours: (typeof body.hours === 'number' ? body.hours : null),
        // null is allowed at creation time so the frontend can render a
        // "Human vs Claude" picker for a freshly-spawned task. Any later PATCH
        // setting assignee = 'ai' or 'human' commits the choice.
        assignee: (body.assignee === 'ai' || body.assignee === 'human') ? body.assignee : null,
        // Blocking: false = independent (queue keeps going past this task);
        // true = queue halts until this task is marked done.
        blocking: body.blocking === true,
        client_id: body.client_id ?? null,
        acceptance_check: body.acceptance_check ?? null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      applyTimerTransition(undefined, card, nowIso);
      await atomicWriteJson(cardPath(id), card);
      // A new queued+AI task lands ready-to-spawn; if the parent's runn switch
      // is on, tick the walker so the queue doesn't sit idle waiting for
      // something else to nudge it. The walker itself enforces ordering /
      // sequential constraints, so this is safe regardless of in-flight state.
      const createStatus = card.status === 'todo' ? 'queued' : card.status;
      if (card.parent_id && card.assignee === 'ai' && createStatus === 'queued') {
        queue.maybeAdvanceQueue(card.parent_id, queueDeps).catch(err =>
          console.error('[runn] queue advance after card create failed', err));
      }
      return sendJson(res, 201, card);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/cards\/([^/]+)$/))) {
      const p = cardPath(mm[1]);
      const card = await readJson(p);
      const body = await readBody(req);
      // Once a card is on an invoice (status invoiced/paid), the fields the
      // invoice depends on are frozen. Status itself can still change (e.g. to
      // void back to 'invoice'), as can title/notes — but client_id and hours
      // must not drift, or we'd be re-billing or mis-attributing work.
      if (card.status === 'invoiced' || card.status === 'paid') {
        const frozen = ['client_id', 'hours'];
        const violated = frozen.filter(k => k in body && body[k] !== card[k]);
        if (violated.length) {
          return sendJson(res, 409, {
            error: `card is on invoice ${card.invoice_id || '(unknown)'}; cannot change ${violated.join(', ')} until the invoice is voided`,
            invoice_id: card.invoice_id || null,
            frozen_fields: violated,
          });
        }
      }
      const merged = {
        ...card, ...body,
        id: card.id,
        created_at: card.created_at,
        updated_at: nowIso(),
      };
      // The conveyor's "completed" set — terminal states for both the done_at
      // stamp and the queue walker. done = personal; invoice/invoiced/paid =
      // the billable tail. Reaching any of them counts as completing the task.
      const COMPLETED_STATUSES = new Set(['done', 'invoice', 'invoiced', 'paid']);
      // done_at lifecycle (done_at is the work's completion date, used as the
      // invoice line date):
      //   - stamped automatically when a card first enters a completed state
      //   - cleared automatically when it leaves the completed set (reopened)
      //   - explicitly settable via PATCH body (backdate historical work)
      const wasCompleted = COMPLETED_STATUSES.has(card.status);
      const nowCompleted = COMPLETED_STATUSES.has(merged.status);
      const stayedDone = wasCompleted && nowCompleted;
      const becameDone = !wasCompleted && nowCompleted;
      const leftDone   = wasCompleted && !nowCompleted;
      if ('done_at' in body) {
        // Explicit user edit wins — null/empty clears, ISO string sets.
        merged.done_at = body.done_at || null;
      } else if (becameDone) {
        merged.done_at = nowIso();
      } else if (leftDone) {
        merged.done_at = null;
      } else if (stayedDone) {
        // Preserve any existing stamp through unrelated edits.
        merged.done_at = card.done_at || null;
      }
      applyTimerTransition(card, merged, nowIso);
      await atomicWriteJson(p, merged);
      // Tick the walker on transitions that could unblock or introduce work:
      //   - any → completed (next sibling can run). "Completed" now spans the
      //     conveyor's terminal states: done / invoice / invoiced / paid.
      //   - blocking just cleared (barrier released)
      //   - newly handed off to AI (status:queued + assignee:ai, no session) —
      //     covers the + AI button on a live-runn project.
      const wasNotDone = !wasCompleted;
      const nowDone = nowCompleted;
      const blockingCleared = card.blocking === true && merged.blocking !== true;
      const mergedStatus = merged.status === 'todo' ? 'queued' : merged.status;
      const becameAiQueued =
        merged.assignee === 'ai' &&
        mergedStatus === 'queued' &&
        !merged.session_id &&
        !(card.assignee === 'ai' && (card.status === 'queued' || card.status === 'todo') && !card.session_id);
      if (((wasNotDone && nowDone) || blockingCleared || becameAiQueued) && merged.parent_id) {
        queue.maybeAdvanceQueue(merged.parent_id, queueDeps).catch(err =>
          console.error('[runn] queue advance after card change failed', err));
      }
      return sendJson(res, 200, merged);
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/archive$/))) {
      const id = mm[1];
      await fsp.rename(cardPath(id), archivePath(id));
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/unarchive$/))) {
      const id = mm[1];
      await fsp.rename(archivePath(id), cardPath(id));
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/ai-ify$/))) {
      const card = await readJson(cardPath(mm[1]));
      if (card.session_id) return sendJson(res, 400, { error: 'card already has a session' });
      // Sequential constraint: every task shares the project's working tree,
      // so we never allow a second AI subprocess while one is already in
      // flight. Even with the parent's Runn switch off, the manual ▶ play
      // button must respect this — block the spawn if any sibling is doing.
      if (card.parent_id) {
        const all = await listCards();
        const busy = all.find(c => c.parent_id === card.parent_id && c.status === 'doing' && c.session_id);
        if (busy) {
          return sendJson(res, 409, { error: `another task is running (${busy.title || busy.id}) — wait for it to finish` });
        }
      }
      // Walk the parent chain to find the nearest set location — projects own
      // the working dir, tasks inherit. Falls back to DEFAULT_LOCATION at the root.
      const location = await resolveCardLocation(card);
      const permissionMode = await resolveCardPermissionMode(card);
      const systemPromptAppend = await resolveCardSystemContext(card);
      try {
        const cardId = card.id;
        const permissionToken = crypto.randomUUID();
        permissionTokens.set(permissionToken, cardId);
        const { session_id, session_path, location: resolvedLoc } = await bridge.spawnSession({
          title: card.title,
          notes: card.notes_md,
          location,
          permissionToken,
          permissionMode,
          systemPromptAppend,
          holder: `card:${cardId}`,
          onExit: (code) => {
            queue.handleAiExit(cardId, code, queueDeps).catch(err =>
              console.error('[runn] queue handleAiExit failed', err));
          },
        });
        sessionIndex.set(session_id, card.id);
        const merged = {
          ...card,
          status: 'doing',
          assignee: 'ai',
          session_id,
          session_path,
          origin: 'runn',
          updated_at: nowIso(),
        };
        applyTimerTransition(card, merged, nowIso);
        await atomicWriteJson(cardPath(card.id), merged);
        console.log(`[runn] ai-ified ${card.id} → session ${session_id.slice(0,8)}`);
        return sendJson(res, 200, merged);
      } catch (err) {
        // Cross-cwd mutex hit — another project is using this working tree.
        // Surface as 409 so the frontend can distinguish from generic spawn
        // failures and show a sensible "another project is running" message.
        if (err && err.code === 'CWD_BUSY') {
          console.log(`[runn] ai-ify ${card.id} blocked: ${err.message}`);
          return sendJson(res, 409, { error: err.message, holder: err.holder, cwd: err.cwd });
        }
        console.error('[runn] ai-ify failed', err);
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/cards\/([^/]+)\/runn$/))) {
      // Toggle the project's autonomous-mode switch. With runn_mode=true the
      // queue walker spawns queued+AI siblings sequentially and handleAiExit
      // auto-promotes review→done; with runn_mode=false queued+AI tasks sit
      // untouched until the user flips it back on. Body: { on: boolean }
      // (defaults to true for back-compat with the original kick-on-click
      // endpoint). An in-flight task is left alone when turning off — Claude
      // is already running and the project drains naturally as it exits.
      const body = await readBody(req).catch(() => ({}));
      const turningOn = body.on !== false;
      const card = await readJson(cardPath(mm[1]));
      if (card.parent_id) return sendJson(res, 400, { error: 'runn only applies to parent cards' });
      const merged = { ...card, runn_mode: turningOn, updated_at: nowIso() };
      await atomicWriteJson(cardPath(card.id), merged);
      console.log(`[runn] runn-mode ${turningOn ? 'ON' : 'OFF'} for ${card.id}`);
      if (turningOn) {
        queue.maybeAdvanceQueue(card.id, queueDeps).catch(err =>
          console.error('[runn] runn maybeAdvanceQueue failed', err));
      }
      return sendJson(res, 200, merged);
    }

    // ── Permission prompts (MCP bridge) ───────────────────────
    // MCP server posts here when Claude wants to use a tool. We hold the
    // response open until the user clicks Allow/Deny in the chat (or a
    // session-wide "always allow" rule short-circuits the wait).
    if (m === 'POST' && url.pathname === '/permissions/request') {
      const body = await readBody(req);
      const cardId = permissionTokens.get(body.token) || null;
      // Short-circuit on persisted "always allow" rules so familiar tools don't pile up prompts.
      if (await isAlwaysAllowed(body.tool_name)) {
        console.log(`[perm] auto-allow ${body.tool_name} (always-allow rule)`);
        return sendJson(res, 200, { behavior: 'allow' });
      }
      const requestId = crypto.randomUUID();
      pendingPermissions.set(requestId, {
        card_id: cardId,
        tool_name: body.tool_name,
        input: body.input,
        created_at: Date.now(),
        send: (decision) => {
          pendingPermissions.delete(requestId);
          sendJson(res, 200, decision);
        },
      });
      // The MCP server may hang for minutes waiting. Disable keepalive timeout
      // on this response so node doesn't reap the socket before the user decides.
      res.setTimeout(0);
      req.on('close', () => {
        // Client (MCP server / Claude) went away — drop the pending request.
        if (pendingPermissions.has(requestId)) pendingPermissions.delete(requestId);
      });
      broadcast({
        type: 'permission.requested',
        request_id: requestId,
        card_id: cardId,
        tool_name: body.tool_name,
        input: body.input,
      });
      return; // response will be sent later via pending.send()
    }
    if (m === 'POST' && url.pathname === '/permissions/decide') {
      const body = await readBody(req);
      const pending = pendingPermissions.get(body.request_id);
      if (!pending) return sendJson(res, 404, { error: 'no such request' });
      const decision = body.decision === 'allow' ? 'allow' : 'deny';
      if (decision === 'allow' && body.remember) {
        await setAlwaysAllowed(pending.tool_name);
      }
      pending.send({ behavior: decision, message: decision === 'deny' ? (body.message || 'denied by user') : undefined });
      broadcast({
        type: 'permission.resolved',
        request_id: body.request_id,
        decision,
        remember: !!body.remember,
      });
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && url.pathname === '/permissions/pending') {
      // Lets the panel rehydrate any in-flight prompts on reload.
      const list = [];
      for (const [id, p] of pendingPermissions) {
        list.push({ request_id: id, card_id: p.card_id, tool_name: p.tool_name, input: p.input, created_at: p.created_at });
      }
      return sendJson(res, 200, list);
    }

    // ── Settings (global) ──────────────────────────────────
    if (m === 'GET' && url.pathname === '/settings') {
      return sendJson(res, 200, await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS));
    }
    if (m === 'PUT' && url.pathname === '/settings') {
      const body = await readBody(req);
      const current = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
      const merged = { ...current, ...body };
      await atomicWriteJson(SETTINGS_PATH, merged);
      return sendJson(res, 200, merged);
    }

    // ── Tag metadata (legacy; tags are pure labels post-migration) ───
    if (m === 'GET' && (mm = url.pathname.match(/^\/tags\/([^/]+)$/))) {
      const tag = mm[1];
      const data = await readJsonOr(tagPath(tag), { tag });
      return sendJson(res, 200, data);
    }
    if (m === 'PUT' && (mm = url.pathname.match(/^\/tags\/([^/]+)$/))) {
      const tag = mm[1];
      const body = await readBody(req);
      const current = await readJsonOr(tagPath(tag), { tag });
      // Strip client_* and invoice_* keys — those now live on clients.
      const sanitized = {};
      for (const [k, v] of Object.entries(body)) {
        if (k.startsWith('client_') || k.startsWith('invoice_')) continue;
        sanitized[k] = v;
      }
      const merged = { ...current, ...sanitized, tag };
      await atomicWriteJson(tagPath(tag), merged);
      return sendJson(res, 200, merged);
    }

    // ── Clients (first-class invoice recipients) ───────────
    if (m === 'GET' && url.pathname === '/clients') {
      const files = await fsp.readdir(CLIENTS_DIR).catch(() => []);
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        try { out.push(await readJson(path.join(CLIENTS_DIR, f))); } catch {}
      }
      out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return sendJson(res, 200, out);
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/clients\/([^/]+)$/))) {
      return sendJson(res, 200, await readJson(clientPath(mm[1])));
    }
    if (m === 'POST' && url.pathname === '/clients') {
      const body = await readBody(req);
      const id = body.id || `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      // Provision the workspace folder + stub CLAUDE.md (idempotent). Body
      // can override the slug explicitly; otherwise we derive from name.
      const workspace = body.workspace
        ? await ensureWorkspace(body.workspace, id)
        : await ensureWorkspace(body.name, id);
      const client = {
        id,
        name: body.name || 'Untitled',
        company: body.company || '',
        address_lines: Array.isArray(body.address_lines) ? body.address_lines : [],
        abn: body.abn || '',
        currency: body.currency || '',
        gst_rate: typeof body.gst_rate === 'number' ? body.gst_rate : null,
        rate_per_hour: typeof body.rate_per_hour === 'number' ? body.rate_per_hour : null,
        invoice_prefix: body.invoice_prefix || '',
        invoice_seq: Number.isFinite(body.invoice_seq) ? body.invoice_seq : 1,
        contact: body.contact || '',
        wg_conf: body.wg_conf || '',
        wg_ip: body.wg_ip || '',
        ssh_user: body.ssh_user || '',
        // Workspace dir for this client — a slug under $HOME/projects.
        // Auto-mkdir'd at client creation. The spawn flow derives cwd from
        // this field; there is no per-project override.
        workspace,
        // Freeform AI context appended to the system prompt on every spawn for
        // tasks under a project linked to this client. People, IPs, platforms,
        // permissions — anything Claude should "just know" without you typing
        // it into every task.
        notes_md: body.notes_md || '',
        // Internal/non-billable clients (e.g. the user's own org) still let
        // you track hours per project but never roll up into outstanding $.
        non_billable: body.non_billable === true,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      await atomicWriteJson(clientPath(id), client);
      return sendJson(res, 201, client);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/clients\/([^/]+)$/))) {
      const p = clientPath(mm[1]);
      const current = await readJson(p);
      const body = await readBody(req);
      const merged = {
        ...current, ...body,
        id: current.id,
        created_at: current.created_at,
        updated_at: nowIso(),
      };
      // Retro-fit: a client created before WORKSPACE PICKER landed has no
      // workspace field. The first PATCH after the upgrade provisions one
      // (derived from name, never silently overwrites an existing CLAUDE.md).
      if (!merged.workspace) {
        merged.workspace = await ensureWorkspace(merged.name, merged.id);
      }
      await atomicWriteJson(p, merged);
      return sendJson(res, 200, merged);
    }
    if (m === 'DELETE' && (mm = url.pathname.match(/^\/clients\/([^/]+)$/))) {
      await fsp.unlink(clientPath(mm[1])).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // ── Invoices ──────────────────────────────────────────
    if (m === 'GET' && url.pathname === '/invoices') {
      const files = await fsp.readdir(INVOICES_DIR).catch(() => []);
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f.startsWith('_')) continue;
        try { out.push(await readJson(path.join(INVOICES_DIR, f))); } catch {}
      }
      out.sort((a, b) => (b.issued_at || '').localeCompare(a.issued_at || ''));
      return sendJson(res, 200, out);
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/invoices\/([^/]+)$/))) {
      // Browser direct-nav (Accept: text/html...) → serve the SPA shell so client-side route renders.
      // JSON fetch (Accept: application/json) → return the invoice data.
      const accept = req.headers.accept || '';
      if (accept.includes('text/html') && !accept.includes('application/json')) {
        return serveStatic(req, res);
      }
      return sendJson(res, 200, await readJson(invoicePath(mm[1])));
    }
    if (m === 'POST' && url.pathname === '/invoices') {
      const body = await readBody(req);
      const inv = await createInvoice(body);
      // Move referenced cards along the conveyor: → 'invoiced' + record invoice_id.
      for (const item of inv.items) {
        if (!item.card_id) continue;
        try {
          const cp = cardPath(item.card_id);
          const c = await readJson(cp);
          await atomicWriteJson(cp, { ...c, status: 'invoiced', invoice_id: inv.id, updated_at: nowIso() });
        } catch (err) {
          console.error(`[runn] failed to flip card ${item.card_id} → invoiced:`, err.message);
        }
      }
      return sendJson(res, 201, inv);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/invoices\/([^/]+)$/))) {
      const id = mm[1];
      const inv = await readJson(invoicePath(id));
      const body = await readBody(req);
      const merged = { ...inv, ...body, id: inv.id, updated_at: nowIso() };
      // Recompute balance if paid changed
      if (typeof merged.paid === 'number') merged.balance = (merged.total_inc_gst || 0) - merged.paid;
      await atomicWriteJson(invoicePath(id), merged);
      // If the invoice flipped to paid, move its cards → 'paid' on the conveyor.
      if (body.status === 'paid' && inv.status !== 'paid') {
        for (const item of inv.items) {
          if (!item.card_id) continue;
          try {
            const cp = cardPath(item.card_id);
            const c = await readJson(cp);
            await atomicWriteJson(cp, { ...c, status: 'paid', updated_at: nowIso() });
          } catch {}
        }
      }
      return sendJson(res, 200, merged);
    }

    if (m === 'POST' && url.pathname === '/sessions') {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return sendJson(res, 400, { error: 'title required' });
      const location = body.location || bridge.DEFAULT_LOCATION;
      try {
        const { session_id, session_path, location: resolvedLoc } = await bridge.spawnSession({
          title: body.title.trim(),
          location,
        });
        const id = mintCardId(session_id);
        const now = nowIso();
        const card = {
          id,
          title: body.title.trim(),
          status: 'doing',
          parent_id: body.parent_id ?? null,
          sort_order: body.sort_order ?? Date.now(),
          session_id,
          session_path,
          origin: 'runn',
          notes_md: '',
          created_at: now,
          updated_at: now,
        };
        // Pre-register so the discovery watcher dedups when it sees the new jsonl
        sessionIndex.set(session_id, id);
        // The card is born `doing`, so start its work clock now — otherwise it
        // accrues no time until it next *re-enters* doing from some other state.
        applyTimerTransition(undefined, card, nowIso);
        await atomicWriteJson(cardPath(id), card);
        console.log(`[runn] spawned session ${session_id.slice(0,8)} → ${card.title}`);
        return sendJson(res, 201, card);
      } catch (err) {
        console.error('[runn] spawn failed', err);
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    }
    if (m === 'GET') return serveStatic(req, res);
    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error('[runn] http error', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

// ── WebSocket ────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

// ── Cards-dir watcher (card CRUD broadcasts) ─────────────────
const cardsWatcher = chokidar.watch(CARDS_DIR, {
  ignored: (p) => p.endsWith('.tmp') || p.includes(`${path.sep}archive${path.sep}`) || p.endsWith(`${path.sep}archive`),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  depth: 1,
});

function cardEvent(type) {
  return async (p) => {
    if (!p.endsWith('.json') || p.endsWith('.tmp')) return;
    const id = path.basename(p, '.json');
    let card;
    if (type === 'card.removed') {
      card = { id };
    } else {
      try { card = await readJson(p); } catch { return; }
    }
    broadcast({ type, card });
  };
}
cardsWatcher.on('add',    cardEvent('card.added'));
cardsWatcher.on('change', cardEvent('card.changed'));
cardsWatcher.on('unlink', cardEvent('card.removed'));

// ── Clients-dir watcher ──────────────────────────────────────
const clientsWatcher = chokidar.watch(CLIENTS_DIR, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  depth: 1,
});
function clientEvent(type) {
  return async (p) => {
    if (!p.endsWith('.json') || p.endsWith('.tmp')) return;
    const id = path.basename(p, '.json');
    let client;
    if (type === 'client.removed') {
      client = { id };
    } else {
      try { client = await readJson(p); } catch { return; }
    }
    broadcast({ type, client });
  };
}
clientsWatcher.on('add',    clientEvent('client.added'));
clientsWatcher.on('change', clientEvent('client.changed'));
clientsWatcher.on('unlink', clientEvent('client.removed'));

// ── Queue dependencies (injected so queue.js stays I/O-isolated) ──
// Cards whose current turn the user has explicitly interrupted. The kill makes
// claude exit by signal (which otherwise looks like a crash); this set tells
// handleAiExit to land the card in `review` rather than `blocked`. The exit
// callback clears the entry.
const interruptedCards = new Set();

const queueDeps = {
  readJson, atomicWriteJson, cardPath, bridge, broadcast,
  listCards, nowIso,
  interruptedCards,
  resolveCardLocation,
  resolveCardPermissionMode,
  resolveCardSystemContext,
  // Mint and register a permission token so MCP requests from this spawn
  // can be tied back to the correct card in the chat UI.
  mintPermissionToken: (cardId) => {
    const t = crypto.randomUUID();
    permissionTokens.set(t, cardId);
    return t;
  },
  onAiExit: (cardId, code) =>
    queue.handleAiExit(cardId, code, queueDeps).catch(err =>
      console.error('[runn] queue handleAiExit failed', err)),
};

// ── Session-discovery watcher ────────────────────────────────
// In-memory index: session_id → card_id (so we can dedup and update titles)
const sessionIndex = new Map();

async function rebuildSessionIndex() {
  sessionIndex.clear();
  let stripped = 0;
  // Walk live + archive so legacy `location` fields don't linger as stale
  // data. Cwd is derived at spawn time from client.workspace, not stored on
  // cards — kept only on adopted external cards where session_path → cwd
  // remains the source of truth.
  for (const dir of [CARDS_DIR, ARCHIVE_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const p = path.join(dir, f);
      let c;
      try { c = await readJson(p); } catch { continue; }
      if (c.session_id && dir === CARDS_DIR) sessionIndex.set(c.session_id, c.id);
      if (c.location && c.origin !== 'external') {
        const { location, ...rest } = c;
        await atomicWriteJson(p, rest);
        stripped++;
      }
    }
  }
  if (stripped) console.log(`[runn] stripped legacy location field from ${stripped} card(s)`);
}

async function adoptSession(jsonlPath) {
  const sessionId = sessionIdFromPath(jsonlPath);
  if (!sessionId) return;
  if (sessionIndex.has(sessionId)) return; // already a card

  const slugMatch = jsonlPath.match(SESSION_PATH_RE);
  const slug = slugMatch ? slugMatch[1] : '';
  const aiTitle = await readLatestAiTitle(jsonlPath);
  const fallback = `${slugToLabel(slug)} · ${sessionId.slice(0, 8)}`;

  const id = mintCardId(sessionId);
  const now = nowIso();
  const card = {
    id,
    title: aiTitle || fallback,
    status: 'doing',
    parent_id: null,
    sort_order: Date.now(),
    session_id: sessionId,
    session_path: jsonlPath,
    location: { type: 'local', cwd: slugToCwd(slug) },
    origin: 'external',
    notes_md: '',
    created_at: now,
    updated_at: now,
  };
  sessionIndex.set(sessionId, id);
  // Adopted externally-spawned sessions land in `doing` too — start their clock
  // from adoption forward (we can't know how long they ran before we saw them).
  applyTimerTransition(undefined, card, nowIso);
  try {
    await atomicWriteJson(cardPath(id), card);
    console.log(`[runn] adopted session ${sessionId.slice(0,8)} → ${card.title}`);
  } catch (err) {
    sessionIndex.delete(sessionId);
    console.error('[runn] adopt failed', err);
  }
}

async function syncSessionTitle(jsonlPath) {
  const sessionId = sessionIdFromPath(jsonlPath);
  if (!sessionId) return;
  const cardId = sessionIndex.get(sessionId);
  if (!cardId) return;
  const aiTitle = await readLatestAiTitle(jsonlPath);
  if (!aiTitle) return;
  try {
    const card = await readJson(cardPath(cardId));
    if (card.title === aiTitle) return;
    const merged = { ...card, title: aiTitle, updated_at: nowIso() };
    await atomicWriteJson(cardPath(cardId), merged);
  } catch {}
}

// Note: no `awaitWriteFinish` here. That option holds the change event back
// until the file is stable, which — for a live streaming jsonl — meant the
// frontend only saw the response *after* claude was completely finished.
// Instead we let chokidar fire raw `change` events and throttle the broadcast
// per-session (leading + trailing edge) so the panel updates as the response
// streams in, without flooding the WS.
const sessionsWatcher = chokidar.watch(CLAUDE_PROJECTS, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true, // skip the 266 existing files on boot
});

const SESSION_UPDATE_THROTTLE_MS = 600;
const sessionUpdateState = new Map(); // session_id → { lastFire, trailing }

function broadcastSessionUpdate(sessionId, jsonlPath) {
  broadcast({ type: 'session.updated', session_id: sessionId });
  syncSessionTitle(jsonlPath).catch(() => {});
}

function scheduleSessionUpdate(sessionId, jsonlPath) {
  const now = Date.now();
  let state = sessionUpdateState.get(sessionId);
  if (!state) {
    state = { lastFire: 0, trailing: null };
    sessionUpdateState.set(sessionId, state);
  }
  const elapsed = now - state.lastFire;
  if (elapsed >= SESSION_UPDATE_THROTTLE_MS) {
    state.lastFire = now;
    if (state.trailing) { clearTimeout(state.trailing); state.trailing = null; }
    broadcastSessionUpdate(sessionId, jsonlPath);
    return;
  }
  // Inside the throttle window — ensure a trailing-edge fire is scheduled so
  // the very last write in a burst still reaches the client.
  if (state.trailing) return;
  state.trailing = setTimeout(() => {
    state.trailing = null;
    state.lastFire = Date.now();
    broadcastSessionUpdate(sessionId, jsonlPath);
  }, SESSION_UPDATE_THROTTLE_MS - elapsed);
}

// Auto-discovery of external CC Desktop / terminal sessions is OFF — Runn is a
// task/invoicing tool, not a session viewer. Only sessions Runn explicitly
// spawned (origin='runn') exist as cards. Chokidar still runs so we can fire
// live-transcript updates on sessions Runn already knows about.
sessionsWatcher.on('add', () => {});
sessionsWatcher.on('change', (p) => {
  if (!p.endsWith('.jsonl')) return;
  const sessionId = sessionIdFromPath(p);
  if (!sessionId) return;
  // Only react if this is a known Runn-owned session. Unknown jsonls are
  // someone else's business (CC Desktop, terminal claude, etc.) — ignored.
  if (!sessionIndex.has(sessionId)) return;
  scheduleSessionUpdate(sessionId, p);
});

// ── Boot ─────────────────────────────────────────────────────
(async function boot() {
  await fsp.mkdir(CARDS_DIR, { recursive: true });
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  await fsp.mkdir(TAGS_DIR, { recursive: true });
  await fsp.mkdir(CLIENTS_DIR, { recursive: true });
  await fsp.mkdir(INVOICES_DIR, { recursive: true });
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  await rebuildSessionIndex();
  await migrateClients.run({
    DATA_ROOT, CARDS_DIR, TAGS_DIR, CLIENTS_DIR, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson, listCards,
    DEFAULT_SETTINGS, nowIso,
  }).catch(err => console.error('[runn] migration v1_clients failed', err));

  await migratePaths.run({
    HOME, CARDS_DIR, ARCHIVE_DIR, CLIENTS_DIR, WORKSPACES_ROOT, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson,
    ensureWorkspace, DEFAULT_SETTINGS, nowIso,
  }).catch(err => console.error('[runn] migration v4_paths failed', err));

  await migrateCwdCollapse.run({
    HOME, CARDS_DIR, ARCHIVE_DIR, CLIENTS_DIR, WORKSPACES_ROOT, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson,
    ensureWorkspace, DEFAULT_SETTINGS, nowIso,
  }).catch(err => console.error('[runn] migration v5_cwd_collapse failed', err));

  // One-time: fold the retired `billing` field into the status conveyor.
  //   billing 'paid'                              → status 'paid'
  //   billing 'invoiced'                          → status 'invoiced'
  //   billing 'unbilled' + done task + billable   → status 'invoice'
  // Personal done tasks stay 'done'; everything else keeps its status. The
  // `billing` field is then dropped. Gated by settings.migrations.v3_status_billing.
  try {
    const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
    if (!(settings.migrations && settings.migrations.v3_status_billing)) {
      const resolveClient = async (card) => {
        let c = card, guard = 0;
        while (c && c.parent_id && guard++ < 8) {
          const r = await cardReadAnywhere(c.parent_id);
          c = r ? r.card : null;
        }
        return c ? (c.client_id || null) : null;
      };
      const billableCache = new Map();
      const isBillable = async (clientId) => {
        if (!clientId) return false;
        if (billableCache.has(clientId)) return billableCache.get(clientId);
        let ok = false;
        try { const cl = await readJson(clientPath(clientId)); ok = !(cl && cl.non_billable); } catch {}
        billableCache.set(clientId, ok);
        return ok;
      };
      let touched = 0;
      for (const dir of [CARDS_DIR, ARCHIVE_DIR]) {
        const files = await fsp.readdir(dir).catch(() => []);
        for (const f of files) {
          if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
          const fp = path.join(dir, f);
          let c;
          try { c = await readJson(fp); } catch { continue; }
          if (!('billing' in c)) continue; // already migrated
          let status = c.status;
          if (c.billing === 'paid') status = 'paid';
          else if (c.billing === 'invoiced') status = 'invoiced';
          else if (c.status === 'done' && c.parent_id && await isBillable(await resolveClient(c))) status = 'invoice';
          const { billing: _drop, ...rest } = c;
          await atomicWriteJson(fp, { ...rest, status, updated_at: nowIso() });
          touched++;
        }
      }
      const cur = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
      await atomicWriteJson(SETTINGS_PATH, { ...cur, migrations: { ...(cur.migrations || {}), v3_status_billing: true } });
      if (touched) console.log(`[runn] migration v3_status_billing: converted ${touched} card(s)`);
      console.log('[runn] migration v3_status_billing complete');
    }
  } catch (err) {
    console.error('[runn] migration v3_status_billing failed', err);
  }

  server.listen(PORT, HOST, () => {
    const urls = [`http://localhost:${PORT}`];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
      }
    }
    console.log(`[runn] worker bound on ${HOST}:${PORT}  (data: ${DATA_ROOT})`);
    console.log(`[runn] watching sessions: ${CLAUDE_PROJECTS}`);
    console.log(`[runn] known sessions: ${sessionIndex.size}`);
    for (const u of urls) console.log(`         ${u}`);
  });
})().catch(err => {
  console.error('[runn] boot failed', err);
  process.exit(1);
});
