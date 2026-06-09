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
const readline = require('readline');
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
// the permission endpoint can map a request back to its job.
const aiState = new Map();        // jobId → { token, cwd }
const permTokenToJob = new Map(); // permission token → jobId (reverse of aiState)
function tokenForJob(jobId, cwd) {
  let s = aiState.get(jobId);
  if (!s) { s = { token: crypto.randomBytes(24).toString('hex'), cwd }; aiState.set(jobId, s); }
  else s.cwd = cwd;
  permTokenToJob.set(s.token, jobId);
  return s.token;
}

// session_id → jobId. Lets the discovery watcher map a changed session jsonl
// back to the job that owns it (other Claude sessions on this box — including
// this very dev session — are not in the index and are ignored). Populated at
// boot from existing jobs and on every invite.
const sessionJobIndex = new Map();

// Per-job serial op queue. AI turn ingestion (watcher) and the exit status
// transition (handleJobExit) both read-modify-write the same job file, so they
// must not interleave — otherwise a trailing ingest could clobber the `review`
// status set on exit and leave the job stuck in `doing` forever. Funnelling
// both through one FIFO chain per job makes the last writer deterministic.
const jobOpChains = new Map(); // jobId → tail promise
function enqueueJobOp(jobId, op) {
  const prev = jobOpChains.get(jobId) || Promise.resolve();
  const next = prev.then(op).catch((err) => console.error('[runn] jobOp', jobId, err));
  jobOpChains.set(jobId, next);
  next.finally(() => { if (jobOpChains.get(jobId) === next) jobOpChains.delete(jobId); });
  return next;
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

// ── Discovery: session jsonl → AI turns ──────────────────────
// The bridge spawns Claude and lets it run detached, writing to its session
// jsonl; the worker never pipes stdout to the browser. Instead we tail that
// jsonl and fold the assistant's replies back into job.turns[] — so a writeJob
// makes the jobs-dir watcher broadcast job.changed and the chat updates live.
//
// We extract ONLY assistant text bubbles (one per API response; tool_use breaks
// a bubble so text→[tool]→text keeps chronological order). User events in the
// jsonl are the synthesised spawn/resume prompts — NOT the human's turns, which
// are already recorded via the HTTP path — so they're skipped. Thinking blocks
// are dropped (redacted noise).
async function parseAiTurns(jsonlPath) {
  const events = [];
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  } catch { return []; }

  const turns = [];
  let open = null;     // { text, id, at } of the assistant bubble being built
  let openId = null;   // its message.id (text from the same id merges)
  const flush = () => {
    if (open && open.text.trim()) turns.push({ text: open.text, id: open.id, at: open.at });
    open = null; openId = null;
  };
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const c = ev.message && ev.message.content;
      if (!Array.isArray(c)) continue;
      const msgId = (ev.message && ev.message.id) || null;
      if (open && msgId && msgId !== openId) flush();
      for (const block of c) {
        if (block.type === 'text' && block.text) {
          if (!open) { open = { text: '', id: msgId, at: ev.timestamp || null }; openId = msgId; }
          open.text = open.text ? `${open.text}\n${block.text}` : block.text;
        } else if (block.type === 'tool_use') {
          // A tool call ends the current text bubble so later text from the same
          // message opens a fresh bubble below it (preserves text → tool → text).
          flush();
        }
        // thinking blocks intentionally ignored
      }
      continue;
    }
    if (ev.type === 'user') {
      const c = ev.message && ev.message.content;
      const isToolResult = Array.isArray(c) && c.length && c.every((b) => b.type === 'tool_result');
      if (!isToolResult) flush(); // a real (prompt) user message closes the bubble
      continue;
    }
    flush();
  }
  flush();
  return turns;
}

// Resolve the on-disk session jsonl for a job (cwd is derived, never stored).
async function sessionPathForJob(job) {
  if (!job || !job.session_id) return null;
  const st = aiState.get(job.id);
  const cwd = (st && st.cwd) || (await resolveLocation(job)).cwd;
  return bridge.sessionPathFor(cwd, job.session_id);
}

// Fold any not-yet-recorded AI turns from the session jsonl into job.turns[].
// Dedup is positional: the jsonl only grows and parsing is deterministic, so the
// first N parsed AI bubbles are invariant — we append only those past the count
// of AI turns already on the job. NEVER touches status (see handleJobExit).
async function ingestSession(jobId, jsonlPath) {
  const job = await jobs.readJobOr(jobId);
  if (!job) return;
  const p = jsonlPath || (await sessionPathForJob(job));
  if (!p) return;
  const parsed = await parseAiTurns(p);
  if (!Array.isArray(job.turns)) job.turns = [];
  const have = job.turns.filter((t) => t.role === 'ai').length;
  if (parsed.length <= have) return; // nothing new
  for (const t of parsed.slice(have)) {
    job.turns.push({ role: 'ai', text: t.text, at: t.at || new Date().toISOString(), msg_id: t.id || null });
  }
  await jobs.writeJob(job);
}

// AI never sets `done` (human-only). A clean turn lands the job in `review`
// (waiting on the human); a crash lands it in `blocked`. We do a FINAL ingest
// first (catch the last reply the watcher may not have flushed yet) THEN flip
// status — both inside the per-job queue so no trailing watcher ingest can
// clobber the status. patchJob stops the work clock; the jobs watcher
// broadcasts job.changed so the UI updates live.
function handleJobExit(jobId, code) {
  enqueueJobOp(jobId, async () => {
    try { await ingestSession(jobId, null); }
    catch (err) { console.error('[runn] handleJobExit ingest', jobId, err); }
    await jobs.patchJob(jobId, { status: code === 0 ? 'review' : 'blocked' });
  });
}

// ── Permission bridge (the gated model) ──────────────────────
// mcp-permission.js POSTs /permissions/request whenever Claude wants a tool; we
// park the held response, surface it to the browser, and resolve it when the
// human clicks Allow/Deny. A persisted "always allow" rule short-circuits the
// wait for familiar tools.
const pendingPermissions = new Map(); // request_id → { send, job_id, tool_name, input, created_at }

// raw_ssh_exec (the human-gated escape hatch) and apply_plan (the single
// execution path for a stored plan body) are PERMANENTLY ineligible for
// "always allow" — they must be approved every single time.
function isApplyPlanToolName(toolName) {
  return /(?:^|__)apply_plan$/.test(String(toolName || ''));
}
function isRawSshToolName(toolName) {
  return /(?:^|__)raw_ssh_exec$/.test(String(toolName || ''));
}
function isAlwaysAllowEligible(toolName) {
  return !isRawSshToolName(toolName) && !isApplyPlanToolName(toolName);
}
async function isAlwaysAllowed(toolName) {
  if (!isAlwaysAllowEligible(toolName)) return false;
  const s = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  return !!(s.permissions && s.permissions.alwaysAllow && s.permissions.alwaysAllow[toolName]);
}
async function setAlwaysAllowed(toolName) {
  if (!isAlwaysAllowEligible(toolName)) return;
  const s = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  s.permissions = s.permissions || {};
  s.permissions.alwaysAllow = s.permissions.alwaysAllow || {};
  s.permissions.alwaysAllow[toolName] = true;
  await atomicWriteJson(SETTINGS_PATH, s);
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
  sessionJobIndex.set(result.session_id, id);
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
    if (m === 'PUT' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/turns\/(\d+)$/))) {
      const id = mm[1];
      const idx = Number(mm[2]);
      const body = await readBody(req);
      if (typeof body.text !== 'string') return badReq(res, 'text required');
      const job = await jobs.readJobOr(id);
      if (!job) return notFound(res);
      // The lock: once AI is invited, the turns are the record it received and
      // can no longer be edited. Before invite they're the human's private notes.
      if (job.session_id) return sendJson(res, 409, { error: 'locked: AI already invited' });
      try { return sendJson(res, 200, await jobs.editTurn(id, idx, body.text)); }
      catch (e) { return badReq(res, e.message); }
    }
    // The human work clock — the browser starts it when the user lands in a job
    // and stops it when the job loses foreground (navigate away / tab hidden /
    // unload). Independent of the AI spinner (status === 'doing').
    if (m === 'POST' && (mm = url.pathname.match(/^\/jobs\/([^/]+)\/clock\/(start|stop)$/))) {
      const id = mm[1], action = mm[2];
      if (!(await jobs.readJobOr(id))) return notFound(res);
      const job = action === 'start' ? await jobs.startClock(id) : await jobs.stopClock(id);
      return sendJson(res, 200, job);
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

    // ── Permission prompts (MCP bridge) ────────────────────
    // mcp-permission.js posts here when Claude wants a tool. We hold the
    // response open until the human clicks Allow/Deny (or an always-allow rule
    // short-circuits the wait). The response shape matches the MCP contract:
    // { behavior: 'allow' | 'deny', message? }.
    if (m === 'POST' && url.pathname === '/permissions/request') {
      const body = await readBody(req);
      const jobId = permTokenToJob.get(body.token) || null;
      if (await isAlwaysAllowed(body.tool_name)) {
        return sendJson(res, 200, { behavior: 'allow' });
      }
      const requestId = crypto.randomUUID();
      pendingPermissions.set(requestId, {
        job_id: jobId,
        tool_name: body.tool_name,
        input: body.input,
        created_at: Date.now(),
        send: (decision) => { pendingPermissions.delete(requestId); sendJson(res, 200, decision); },
      });
      // The MCP server may hang for minutes; disable keepalive so node doesn't
      // reap the socket before the human decides.
      res.setTimeout(0);
      // If the socket closes before a decision (Claude's child was killed
      // mid-turn), drop the pending request AND tell connected browsers so the
      // card clears live instead of sticking around un-clickable. The guard
      // skips the normal case where send() already deleted it after a decision.
      req.on('close', () => {
        if (pendingPermissions.delete(requestId)) {
          broadcast({ type: 'permission.resolved', request_id: requestId, decision: 'deny', remember: false });
        }
      });
      broadcast({
        type: 'permission.requested',
        request_id: requestId,
        job_id: jobId,
        tool_name: body.tool_name,
        input: body.input,
      });
      return; // response sent later via pending.send()
    }
    if (m === 'POST' && url.pathname === '/permissions/decide') {
      const body = await readBody(req);
      const pending = pendingPermissions.get(body.request_id);
      if (!pending) return sendJson(res, 404, { error: 'no such request' });
      const decision = body.decision === 'allow' ? 'allow' : 'deny';
      if (decision === 'allow' && body.remember) await setAlwaysAllowed(pending.tool_name);
      pending.send({ behavior: decision, message: decision === 'deny' ? (body.message || 'denied by user') : undefined });
      broadcast({ type: 'permission.resolved', request_id: body.request_id, decision, remember: !!body.remember });
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'GET' && url.pathname === '/permissions/pending') {
      const list = [];
      for (const [id, p] of pendingPermissions) {
        list.push({ request_id: id, job_id: p.job_id, tool_name: p.tool_name, input: p.input, created_at: p.created_at });
      }
      return sendJson(res, 200, list);
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

// ── Discovery watcher: session jsonl → AI turns ──────────────
// Claude Code lays sessions at ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
// (depth 2). On any change to a jsonl whose sessionId belongs to a Runn job, we
// fold the new AI turns in (serialised via the per-job queue). Every other
// Claude session on this box — including the one editing Runn itself — is absent
// from sessionJobIndex and ignored.
const SESSIONS_ROOT = path.join(process.env.HOME || os.homedir(), '.claude', 'projects');
const sessionsWatcher = chokidar.watch(SESSIONS_ROOT, {
  ignored: (p) => p.endsWith('.tmp'),
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  depth: 2,
});
function onSessionEvent(p) {
  if (!p.endsWith('.jsonl')) return;
  const sessionId = path.basename(p, '.jsonl');
  const jobId = sessionJobIndex.get(sessionId);
  if (!jobId) return;
  enqueueJobOp(jobId, () => ingestSession(jobId, p));
}
sessionsWatcher.on('add', onSessionEvent);
sessionsWatcher.on('change', onSessionEvent);

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  await jobs.init();
  await invoices.init();
  await ensureDir(CLIENTS_DIR);
  // Rebuild the session index from existing jobs and catch up any AI turns the
  // worker missed while it was down (e.g. it died mid-turn before ingesting).
  // No Claude child survives a worker restart (systemd KillMode=control-group
  // reaps the detached children), so any job left in `doing` is orphaned — its
  // turn can never fire handleJobExit. Do a final catch-up ingest, then flip it
  // to `review` so the UI spinner clears instead of hanging forever.
  for (const j of await jobs.listJobs({ includeArchived: true })) {
    const wasDoing = j.status === 'doing';
    // A human work clock left running across a restart (the browser never got
    // to POST clock/stop) would otherwise tick forever — fold it now. The
    // `doing` case is handled by patchJob→review (which folds the clock too).
    const staleClock = !wasDoing && j.doing_started_at;
    if (j.session_id) {
      sessionJobIndex.set(j.session_id, j.id);
      enqueueJobOp(j.id, async () => {
        await ingestSession(j.id, null);
        if (wasDoing) await jobs.patchJob(j.id, { status: 'review' });
        else if (staleClock) await jobs.stopClock(j.id);
      });
    } else if (wasDoing) {
      enqueueJobOp(j.id, () => jobs.patchJob(j.id, { status: 'review' }));
    } else if (staleClock) {
      enqueueJobOp(j.id, () => jobs.stopClock(j.id));
    }
  }
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
