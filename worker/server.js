'use strict';

// The Runn worker — job-centric rebuild (RUNN_PLAN.md section 9, step 2).
//
// This is the BACKEND SKELETON: a flat HTTP + WebSocket server over the job
// data layer (jobs.js) and the shared FS store (store.js). It serves the
// frontend shell, exposes /jobs + /clients + /settings, and turns on-disk
// changes into live WebSocket broadcasts via chokidar.
//
// Deliberately NOT here yet (later steps, ported from the old card server which
// is preserved on `main` + the `v1-cards` tag): AI spawn/resume (bridge.js),
// the MCP permission bridge, invoices, hours timer, worktrees. Keep this lean.

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const {
  DATA_ROOT, readJson, readJsonOr, atomicWriteJson, ensureDir,
} = require('./store');
const jobs = require('./jobs');
const invoices = require('./invoices');
const bridge = require('./bridge');

// ── Config ───────────────────────────────────────────────────
const CLIENTS_DIR = path.join(DATA_ROOT, 'clients');
const ASSETS_DIR = path.join(DATA_ROOT, 'assets');
const SETTINGS_PATH = path.join(DATA_ROOT, 'settings.json');
const PORT = Number(process.env.PORT || 17777);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const MAX_BODY_BYTES = 50 * 1024 * 1024;

const clientPath = (id) => path.join(CLIENTS_DIR, `${id}.json`);

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
  // Default workspace slug for jobs with no client (personal work).
  personal_workspace: 'waz',
};

// ── AI engine (RUNN_PLAN: spawn/resume Claude per job turn) ───
// cwd is derived from the job's client.workspace at spawn time (never stored on
// the job). Client → /home/waz/projects/<workspace>; client-less → the
// personal_workspace setting; neither → bridge's DEFAULT_LOCATION (~/runn-data).
const PROJECTS_ROOT = path.join(process.env.HOME || os.homedir(), 'projects');

// Per-job permission token, minted on first spawn and reused across resumes so
// the (forthcoming) permission endpoint can map a request back to its job.
const aiState = new Map(); // jobId → { token, cwd }
function tokenForJob(jobId, cwd) {
  let s = aiState.get(jobId);
  if (!s) { s = { token: crypto.randomBytes(24).toString('hex'), cwd }; aiState.set(jobId, s); }
  else s.cwd = cwd;
  return s.token;
}

const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 120).trim();

async function resolveLocation(job) {
  let workspace = null;
  if (job.client_id) {
    const cl = await readJsonOr(clientPath(job.client_id), null);
    if (cl && cl.workspace) workspace = cl.workspace;
  }
  if (!workspace) {
    const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
    if (settings.personal_workspace) workspace = settings.personal_workspace;
  }
  if (!workspace) return bridge.DEFAULT_LOCATION;
  return { type: 'local', cwd: path.join(PROJECTS_ROOT, workspace) };
}

// AI never sets `done` (human-only). A clean turn lands the job in `review`
// (waiting on the human); a crash lands it in `blocked`. patchJob stops the
// work clock; the jobs watcher broadcasts job.changed so the UI updates live.
async function handleJobExit(jobId, code) {
  try {
    await jobs.patchJob(jobId, { status: code === 0 ? 'review' : 'blocked' });
  } catch (err) {
    console.error('[runn] handleJobExit', jobId, err);
  }
}

// Invite Claude to a job (the "+ AI" handover). Claude is never spawned and
// never sees a job's contents until this is called — before invite the job is
// the human's private space. The handover prompt is the job's accumulated user
// turns plus its notes companion. Spawns the session, flips the job to `doing`.
async function inviteAi(res, job) {
  const id = job.id;
  if (job.session_id) return sendJson(res, 409, { error: 'AI already invited' });
  const location = await resolveLocation(job);
  const token = tokenForJob(id, location.cwd);
  const companion = (await jobs.readNotes(id)).trim();
  const userTurns = (job.turns || []).filter((t) => t.role === 'user').map((t) => t.text);
  // bridge composes the spawn prompt as `${title}\n\n${notes}`. Keep title and
  // body DISJOINT (V1's model) so the handover isn't duplicated: when the job is
  // unnamed, its first message becomes the title line and the remaining messages
  // (plus the notes companion) form the body; when already named, every message
  // goes in the body.
  const title = job.title || firstLine(userTurns[0] || '') || 'New job';
  const bodyTurns = job.title ? userTurns : userTurns.slice(1);
  const promptBody = [...bodyTurns, companion].filter(Boolean).join('\n\n');
  let result;
  try {
    result = await bridge.spawnSession({
      title,
      notes: promptBody,
      location,
      permissionToken: token,
      permissionMode: 'default', // gated via --permission-prompt-tool, not a mode
      onExit: (code) => handleJobExit(id, code),
      holder: 'job:' + id,
    });
  } catch (e) {
    if (e.code === 'CWD_BUSY') return sendJson(res, 202, { queued: true, busy: true, holder: e.holder });
    throw e;
  }
  await jobs.patchJob(id, { session_id: result.session_id, status: 'doing' });
  return sendJson(res, 201, await jobs.readJob(id));
}

// Resume an already-invited job with a follow-up user turn, flipping it back to
// `doing`. On cwd contention the turn buffers and bridge auto-dispatches it when
// the cwd frees (202).
async function resumeJob(res, job, text) {
  const id = job.id;
  const location = await resolveLocation(job);
  const token = tokenForJob(id, location.cwd);
  const params = {
    text, location, permissionToken: token, permissionMode: 'default',
    onExit: (code) => handleJobExit(id, code), holder: 'job:' + id,
  };
  try {
    await bridge.sendMessage({ sessionId: job.session_id, ...params });
  } catch (e) {
    if (e.code === 'CWD_BUSY') {
      bridge.enqueueMessage(job.session_id, {
        ...params,
        onStart: () => { jobs.patchJob(id, { status: 'doing' }).catch(() => {}); },
      });
      return sendJson(res, 202, { queued: true });
    }
    throw e;
  }
  await jobs.patchJob(id, { status: 'doing' });
  return sendJson(res, 201, await jobs.readJob(id));
}

// ── HTTP helpers ─────────────────────────────────────────────
function sendJson(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, no-cache, must-revalidate',
  });
  res.end(JSON.stringify(body));
}
const notFound = (res) => sendJson(res, 404, { error: 'not found' });
const badReq = (res, msg) => sendJson(res, 400, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        try { req.destroy(err); } catch {}
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks).toString('utf8');
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) { reject(e); }
    });
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
       : p.endsWith('.gif')       ? 'image/gif'
       : p.endsWith('.webmanifest') ? 'application/manifest+json'
       :                            'application/octet-stream';
}

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  // /assets/* served from ~/runn-data/assets/ (logo etc).
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
      // SPA fallback: extension-less GET serves index.html so client-side
      // routing works on direct load + browser reload.
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
    res.writeHead(200, {
      'content-type': ctFor(p),
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
}

// ── HTTP routes ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const m = req.method;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let mm;
  try {
    // ── Jobs ───────────────────────────────────────────────
    if (m === 'GET' && url.pathname === '/jobs') {
      const includeArchived = url.searchParams.get('archived') === '1';
      return sendJson(res, 200, await jobs.listJobs({ includeArchived }));
    }
    if (m === 'POST' && url.pathname === '/jobs') {
      const body = await readBody(req);
      const job = await jobs.createJob({ client_id: body.client_id ?? null, title: body.title ?? null });
      return sendJson(res, 201, job);
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/jobs\/([^/]+)$/))) {
      const job = await jobs.readJobOr(mm[1]);
      return job ? sendJson(res, 200, job) : notFound(res);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/jobs\/([^/]+)$/))) {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, await jobs.patchJob(mm[1], body));
      } catch (e) { return badReq(res, e.message); }
    }
    if (m === 'DELETE' && (mm = url.pathname.match(/^\/jobs\/([^/]+)$/))) {
      await jobs.deleteJob(mm[1]);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/turn$/))) {
      const id = mm[1];
      const body = await readBody(req);
      if (!body.role || typeof body.text !== 'string') return badReq(res, 'role and text required');
      let job;
      try { job = await jobs.appendTurn(id, body); }
      catch (e) { return badReq(res, e.message); }
      // The invite gate: Claude is never spawned by a turn. Before invite a job
      // is the human's private space — turns are recorded only. After invite
      // (job.session_id set), a user turn resumes the existing session.
      if (body.role === 'user' && job.session_id) {
        try { return await resumeJob(res, job, body.text); }
        catch (e) {
          console.error('[runn] resume failed', id, e);
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }
      return sendJson(res, 201, job);
    }
    if (m === 'POST' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/invite-ai$/))) {
      const id = mm[1];
      const job = await jobs.readJobOr(id);
      if (!job) return notFound(res);
      try { return await inviteAi(res, job); }
      catch (e) {
        console.error('[runn] inviteAi failed', id, e);
        return sendJson(res, 500, { error: String(e.message || e) });
      }
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/notes$/))) {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await jobs.readNotes(mm[1]));
    }
    if (m === 'PUT' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/notes$/))) {
      const body = await readBody(req);
      await jobs.writeNotes(mm[1], typeof body.md === 'string' ? body.md : '');
      return sendJson(res, 200, { ok: true });
    }

    // ── Invoices (issued only; drafts are computed live in the frontend) ──
    if (m === 'GET' && url.pathname === '/invoices') {
      return sendJson(res, 200, await invoices.listInvoices());
    }
    if (m === 'POST' && url.pathname === '/invoices') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, await invoices.createInvoice(body));
      } catch (e) { return badReq(res, e.message); }
    }
    if (m === 'GET' && (mm = url.pathname.match(/^\/invoices\/([^/]+)$/))) {
      const inv = await invoices.readInvoiceOr(mm[1]);
      return inv ? sendJson(res, 200, inv) : notFound(res);
    }
    if (m === 'PATCH' && (mm = url.pathname.match(/^\/invoices\/([^/]+)$/))) {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, await invoices.patchInvoice(mm[1], body));
      } catch (e) { return badReq(res, e.message); }
    }
    if (m === 'DELETE' && (mm = url.pathname.match(/^\/invoices\/([^/]+)$/))) {
      await invoices.voidInvoice(mm[1]);
      return sendJson(res, 200, { ok: true });
    }

    // ── Clients (read-only here; CRUD ported with billing later) ──
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
      const cl = await readJsonOr(clientPath(mm[1]), null);
      return cl ? sendJson(res, 200, cl) : notFound(res);
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

    // ── Static frontend (+ SPA fallback) ───────────────────
    if (m === 'GET') return serveStatic(req, res);
    return notFound(res);
  } catch (err) {
    console.error('[runn] http error', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

// ── WebSocket ────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(data);
}

// ── Watchers: on-disk changes → live broadcasts ──────────────
// JOBS_DIR is flat; `.notes.md` companions are ignored (the `.json` filter
// drops them) so a notes write doesn't masquerade as a record change.
const jobsWatcher = chokidar.watch(jobs.JOBS_DIR, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  depth: 0,
});
function jobEvent(type) {
  return async (p) => {
    if (!p.endsWith('.json') || p.endsWith('.tmp')) return;
    const id = path.basename(p, '.json');
    if (type === 'job.removed') return broadcast({ type, job: { id } });
    const job = await jobs.readJobOr(id);
    if (job) broadcast({ type, job });
  };
}
jobsWatcher.on('add',    jobEvent('job.added'));
jobsWatcher.on('change', jobEvent('job.changed'));
jobsWatcher.on('unlink', jobEvent('job.removed'));

const clientsWatcher = chokidar.watch(CLIENTS_DIR, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  depth: 0,
});
function clientEvent(type) {
  return async (p) => {
    if (!p.endsWith('.json') || p.endsWith('.tmp')) return;
    const id = path.basename(p, '.json');
    if (type === 'client.removed') return broadcast({ type, client: { id } });
    const client = await readJsonOr(path.join(CLIENTS_DIR, `${id}.json`), null);
    if (client) broadcast({ type, client });
  };
}
clientsWatcher.on('add',    clientEvent('client.added'));
clientsWatcher.on('change', clientEvent('client.changed'));
clientsWatcher.on('unlink', clientEvent('client.removed'));

const invoicesWatcher = chokidar.watch(invoices.INVOICES_DIR, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  depth: 0,
});
function invoiceEvent(type) {
  return async (p) => {
    if (!p.endsWith('.json') || p.endsWith('.tmp')) return;
    const id = path.basename(p, '.json');
    if (type === 'invoice.removed') return broadcast({ type, invoice: { id } });
    const inv = await invoices.readInvoiceOr(id);
    if (inv) broadcast({ type, invoice: inv });
  };
}
invoicesWatcher.on('add',    invoiceEvent('invoice.added'));
invoicesWatcher.on('change', invoiceEvent('invoice.changed'));
invoicesWatcher.on('unlink', invoiceEvent('invoice.removed'));

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  await jobs.init();
  await invoices.init();
  await ensureDir(CLIENTS_DIR);
  server.listen(PORT, HOST, () => {
    const urls = [`http://localhost:${PORT}`];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces || []) {
        if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
      }
    }
    console.log(`[runn] worker bound on ${HOST}:${PORT}  (data: ${DATA_ROOT})`);
    for (const u of urls) console.log(`         ${u}`);
  });
})().catch((err) => {
  console.error('[runn] boot failed', err);
  process.exit(1);
});
