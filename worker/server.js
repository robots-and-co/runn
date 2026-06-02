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
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const {
  DATA_ROOT, readJson, readJsonOr, atomicWriteJson, ensureDir,
} = require('./store');
const jobs = require('./jobs');
const invoices = require('./invoices');

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
      const body = await readBody(req);
      if (!body.role || typeof body.text !== 'string') return badReq(res, 'role and text required');
      try {
        const job = await jobs.appendTurn(mm[1], body);
        return sendJson(res, 201, job);
      } catch (e) { return badReq(res, e.message); }
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
