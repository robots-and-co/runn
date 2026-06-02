'use strict';

// The job data layer. A JOB is the whole unit: one long chat that spans days,
// the unit of work, of conversation, and of billing. It replaces the old
// card/project/task model entirely. See RUNN_PLAN.md section 4.
//
//   jobs/<id>.json      the record (turns[] live inline + session_id for resume)
//   jobs/<id>.notes.md  the Runn-driven lossless running-notes companion
//
// cwd is NOT stored here — it is derived from the job's client.workspace at
// spawn time (preserves the old invariant so the per-cwd lock and the
// <client>-ops MCP selection stay correct).

const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { DATA_ROOT, readJson, atomicWriteJson, ensureDir, listJsonIds } = require('./store');

const JOBS_DIR = path.join(DATA_ROOT, 'jobs');

// The conveyor (RUNN_PLAN section 11, DECIDED). `review` = AI is waiting on the
// HUMAN (question/approval/decision). `blocked` = waiting on something/someone
// OTHER than the human (third party, outage). The two are distinct.
const STATUSES = ['open', 'doing', 'review', 'done', 'invoiced', 'paid', 'blocked', 'hold'];
const ROLES = ['user', 'ai'];

const jobPath = (id) => path.join(JOBS_DIR, `${id}.json`);
const notesPath = (id) => path.join(JOBS_DIR, `${id}.notes.md`);

function newId() {
  return `j_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

const nowIso = () => new Date().toISOString();

async function init() {
  await ensureDir(JOBS_DIR);
}

function freshJob({ client_id = null, title = null } = {}) {
  const now = nowIso();
  return {
    id: newId(),
    client_id,
    title,                 // AI-named from the first turn, user-editable
    status: 'open',
    created_at: now,
    updated_at: now,
    due_at: null,          // when the work is due (YYYY-MM-DD); user-set, optional
    done_at: null,
    doing_started_at: null, // v1 work-clock: stamped while status === 'doing'
    work_seconds: 0,       // accrued by the active-work timer; hours derives from it
    hours: 0,              // active-work hours, hand-editable before invoicing
    turns: [],             // [{ role:'user'|'ai', text, at, session_event? }]
    session_id: null,      // Claude Code session id, for --resume
    invoice_summary: null, // client-facing one-liner, distinct from title
    invoice_id: null,
    invoice_line_id: null,
    archived: false,
  };
}

async function createJob(opts = {}) {
  await init();
  const job = freshJob(opts);
  await atomicWriteJson(jobPath(job.id), job);
  return job;
}

async function readJob(id) {
  return readJson(jobPath(id));
}

async function readJobOr(id, fallback = null) {
  try { return await readJob(id); } catch { return fallback; }
}

async function writeJob(job) {
  job.updated_at = nowIso();
  await atomicWriteJson(jobPath(job.id), job);
  return job;
}

async function listJobs({ includeArchived = false } = {}) {
  const ids = await listJsonIds(JOBS_DIR);
  const jobs = [];
  for (const id of ids) {
    const j = await readJobOr(id);
    if (!j) continue;
    if (!includeArchived && j.archived) continue;
    jobs.push(j);
  }
  // Most-recently-touched first — the list pane's default order.
  jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return jobs;
}

// Append one turn. session_event marks a dated session/day divider inside the
// single continuous thread (sessions are not separate objects).
async function appendTurn(id, { role, text, session_event = null, at = null }) {
  if (!ROLES.includes(role)) throw new Error(`bad turn role: ${role}`);
  const job = await readJob(id);
  const turn = { role, text, at: at || nowIso() };
  if (session_event) turn.session_event = session_event;
  job.turns.push(turn);
  return writeJob(job);
}

// Patch scalar fields only. Immutable/append-only fields (id, created_at,
// turns) are never patched here — turns go through appendTurn.
async function patchJob(id, patch = {}) {
  if (patch.status && !STATUSES.includes(patch.status)) {
    throw new Error(`bad status: ${patch.status}`);
  }
  const job = await readJob(id);
  const prevStatus = job.status;
  const { id: _id, created_at: _ca, turns: _t, ...rest } = patch;
  Object.assign(job, rest);
  if (patch.status === 'done' && !job.done_at) job.done_at = nowIso();
  if (patch.status && patch.status !== prevStatus) applyTimerTransition(prevStatus, job);
  return writeJob(job);
}

async function setStatus(id, status) {
  return patchJob(id, { status });
}

// The work clock (v1 model). Time accrues only while status === 'doing': we
// stamp `doing_started_at` on entering `doing`, and on leaving fold the elapsed
// wall-clock into `work_seconds` (hours re-derives). `review`/`done`/`blocked`
// etc. are idle — review especially is human approval time, not effort.
// Back-fills work_seconds from any pre-existing hand-entered hours. Mutates job.
function applyTimerTransition(prevStatus, job) {
  if (prevStatus === 'doing' && job.status !== 'doing') {
    if (job.doing_started_at) {
      const elapsed = Math.round((Date.now() - new Date(job.doing_started_at).getTime()) / 1000);
      if (elapsed > 0) {
        if (job.work_seconds == null) job.work_seconds = Math.round((Number(job.hours) || 0) * 3600);
        job.work_seconds += elapsed;
        job.hours = Math.round((job.work_seconds / 3600) * 100) / 100;
      }
    }
    job.doing_started_at = null;
  } else if (job.status === 'doing' && prevStatus !== 'doing') {
    job.doing_started_at = nowIso();
  }
}

// Hard delete: drop the record and its notes companion. The chokidar unlink
// watcher broadcasts job.removed, so connected clients drop it live.
async function deleteJob(id) {
  await fsp.rm(jobPath(id), { force: true });
  await fsp.rm(notesPath(id), { force: true });
}

async function readNotes(id) {
  try { return await fsp.readFile(notesPath(id), 'utf8'); } catch { return ''; }
}

async function writeNotes(id, md) {
  await init();
  const p = notesPath(id);
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, md);
  await fsp.rename(tmp, p);
}

module.exports = {
  STATUSES,
  ROLES,
  JOBS_DIR,
  jobPath,
  notesPath,
  newId,
  init,
  createJob,
  readJob,
  readJobOr,
  writeJob,
  listJobs,
  appendTurn,
  patchJob,
  setStatus,
  deleteJob,
  readNotes,
  writeNotes,
};
