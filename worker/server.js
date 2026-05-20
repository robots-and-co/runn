'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const bridge = require('./bridge');

// ── Config ───────────────────────────────────────────────────
const HOME = process.env.HOME;
const DATA_ROOT = path.join(HOME, 'runn-data');
const CARDS_DIR = path.join(DATA_ROOT, 'cards');
const ARCHIVE_DIR = path.join(CARDS_DIR, 'archive');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const PORT = Number(process.env.PORT || 17777);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const cardPath = (id) => path.join(CARDS_DIR, `${id}.json`);
const archivePath = (id) => path.join(ARCHIVE_DIR, `${id}.json`);
const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'));

async function atomicWriteJson(p, data) {
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
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

function nowIso() { return new Date().toISOString(); }
function mintCardId(seed) {
  if (seed) return `c_${seed.slice(0, 8)}`;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
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
  // Merge consecutive assistant events into one turn (Claude Code splits one response across multiple entries).
  // We deliberately drop `thinking` blocks (almost always redacted) and `tool_use` blocks (implementation noise).
  let openAssistant = null;
  const flushAssistant = () => {
    if (!openAssistant) return;
    if (openAssistant.text) turns.push(openAssistant);
    openAssistant = null;
  };

  const SKIP = new Set(['ai-title', 'queue-operation', 'last-prompt', 'attachment', 'file-history-snapshot', 'permission-mode']);
  for (const ev of events) {
    if (SKIP.has(ev.type)) continue; // metadata — does not break turns
    const ts = ev.timestamp || ev.ts || null;
    if (ev.type === 'assistant') {
      const c = ev.message?.content;
      if (!Array.isArray(c)) continue;
      for (const block of c) {
        if (block.type === 'text' && block.text) {
          if (!openAssistant) openAssistant = { kind: 'assistant', text: '', ts };
          openAssistant.text = openAssistant.text ? `${openAssistant.text}\n${block.text}` : block.text;
        }
        // thinking + tool_use blocks intentionally ignored
      }
      continue;
    }

    if (ev.type === 'user') {
      const c = ev.message?.content;
      const isPureToolResult = Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result');
      if (isPureToolResult) continue; // already paired into the open assistant turn — don't break it
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
  res.writeHead(code, { 'content-type': 'application/json' });
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
function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const full = path.normalize(path.join(FRONTEND_DIR, p));
  if (!full.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ct = p.endsWith('.html')      ? 'text/html; charset=utf-8'
             : p.endsWith('.css')       ? 'text/css'
             : p.endsWith('.js')        ? 'application/javascript'
             : p.endsWith('.json')      ? 'application/manifest+json'
             : p.endsWith('.svg')       ? 'image/svg+xml'
             : p.endsWith('.png')       ? 'image/png'
             : p.endsWith('.webmanifest') ? 'application/manifest+json'
             :                            'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(data);
  });
}

// ── HTTP routes ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const m = req.method;
    let mm;

    if (m === 'GET' && url.pathname === '/cards') {
      return sendJson(res, 200, await listCards());
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
      const location = card.location || locationFromSessionPath(card.session_path);
      if (!location) return sendJson(res, 400, { error: 'card has no resolvable location' });
      try {
        await bridge.sendMessage({
          sessionId: card.session_id,
          text: body.text.trim(),
          location,
        });
        return sendJson(res, 202, { ok: true });
      } catch (err) {
        console.error('[runn] sendMessage failed', err);
        return sendJson(res, 500, { error: String(err.message || err) });
      }
    }
    if (m === 'POST' && url.pathname === '/cards') {
      const body = await readBody(req);
      const id = body.id || mintCardId();
      const card = {
        id,
        title: body.title || 'Untitled',
        status: body.status || 'todo',
        parent_id: body.parent_id ?? null,
        sort_order: body.sort_order ?? Date.now(),
        session_id: body.session_id ?? null,
        session_path: body.session_path ?? null,
        origin: body.origin || 'runn',
        notes_md: body.notes_md || '',
        tags: Array.isArray(body.tags) ? body.tags : [],
        hours: (typeof body.hours === 'number' ? body.hours : null),
        billing: body.billing || 'unbilled',
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      await atomicWriteJson(cardPath(id), card);
      return sendJson(res, 201, card);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/cards\/([^/]+)$/))) {
      const p = cardPath(mm[1]);
      const card = await readJson(p);
      const body = await readBody(req);
      const merged = {
        ...card, ...body,
        id: card.id,
        created_at: card.created_at,
        updated_at: nowIso(),
      };
      await atomicWriteJson(p, merged);
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
      const location = card.location || bridge.DEFAULT_LOCATION;
      try {
        const { session_id, session_path, location: resolvedLoc } = await bridge.spawnSession({
          title: card.title,
          location,
        });
        sessionIndex.set(session_id, card.id);
        const merged = {
          ...card,
          status: 'doing',
          session_id,
          session_path,
          location: resolvedLoc,
          origin: 'runn',
          updated_at: nowIso(),
        };
        await atomicWriteJson(cardPath(card.id), merged);
        console.log(`[runn] ai-ified ${card.id} → session ${session_id.slice(0,8)}`);
        return sendJson(res, 200, merged);
      } catch (err) {
        console.error('[runn] ai-ify failed', err);
        return sendJson(res, 500, { error: String(err.message || err) });
      }
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
          location: resolvedLoc,
          origin: 'runn',
          notes_md: '',
          created_at: now,
          updated_at: now,
        };
        // Pre-register so the discovery watcher dedups when it sees the new jsonl
        sessionIndex.set(session_id, id);
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

// ── Session-discovery watcher ────────────────────────────────
// In-memory index: session_id → card_id (so we can dedup and update titles)
const sessionIndex = new Map();

async function rebuildSessionIndex() {
  sessionIndex.clear();
  let backfilled = 0;
  for (const c of await listCards()) {
    if (c.session_id) sessionIndex.set(c.session_id, c.id);
    // Backfill location for cards from before the field existed
    if (!c.location && c.session_path) {
      const loc = locationFromSessionPath(c.session_path);
      if (loc) {
        await atomicWriteJson(cardPath(c.id), { ...c, location: loc });
        backfilled++;
      }
    }
  }
  if (backfilled) console.log(`[runn] backfilled location on ${backfilled} card(s)`);
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

const sessionsWatcher = chokidar.watch(CLAUDE_PROJECTS, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true, // skip the 266 existing files on boot
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});
sessionsWatcher.on('add',    p => p.endsWith('.jsonl') && adoptSession(p));
sessionsWatcher.on('change', async (p) => {
  if (!p.endsWith('.jsonl')) return;
  const sessionId = sessionIdFromPath(p);
  if (!sessionId) return;
  if (!sessionIndex.has(sessionId)) {
    // First time we see this session (resumed historical) → adopt
    await adoptSession(p);
  } else {
    // Known session: ALWAYS broadcast so open panels refresh, regardless of title sync.
    broadcast({ type: 'session.updated', session_id: sessionId });
    await syncSessionTitle(p);
  }
});

// ── Boot ─────────────────────────────────────────────────────
(async function boot() {
  await fsp.mkdir(CARDS_DIR, { recursive: true });
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
  await rebuildSessionIndex();

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
