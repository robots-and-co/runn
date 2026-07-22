'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Auto-resume scheduler.
//
// When a job's Claude turn dies because the account's usage allowance ran out,
// the server parks the job: status `blocked` plus a `resume_at` timestamp (the
// reset time, read from the CLI's own notice — see bridge.parseUsageLimit).
// This module holds one timer per parked job; when the reset time arrives it
// calls deps.resume(jobId), which nudges the session back to life.
//
// Timers live only in memory, so they MUST be rebuilt from disk on boot (the
// worker restarts and no Claude child survives that). start() re-arms every job
// that still carries a resume_at; a resume_at already in the PAST (missed while
// the worker was down) fires ~immediately.
// ─────────────────────────────────────────────────────────────────────────

const timers = new Map();      // jobId → timeout handle
const MAX = 2_147_000_000;     // setTimeout caps near 24.8 days; re-arm past it

function cancel(jobId) {
  const h = timers.get(jobId);
  if (h) { clearTimeout(h); timers.delete(jobId); }
}

function scheduleJob(job, deps) {
  if (!job || !job.id) return;
  cancel(job.id);
  const at = job.resume_at ? new Date(job.resume_at).getTime() : null;
  if (!at || Number.isNaN(at)) return;
  const delay = Math.max(0, at - Date.now());
  const handle = setTimeout(
    () => (delay > MAX ? scheduleJob(job, deps) : fire(job.id, deps)),
    Math.min(delay, MAX),
  );
  timers.set(job.id, handle);
}

async function fire(jobId, deps) {
  timers.delete(jobId);
  try { await deps.resume(jobId); }
  catch (err) { console.error('[scheduler] auto-resume failed', jobId, err); }
}

// Boot: rebuild every timer from disk.
async function start(deps) {
  const all = await deps.listJobs();
  let n = 0;
  for (const j of all) {
    if (j && j.resume_at) { scheduleJob(j, deps); n++; }
  }
  console.log(`[scheduler] armed ${n} auto-resume timer(s)`);
}

// Called from the jobs watcher so a manual clear (user resumed/edited the job)
// cancels the timer, and a fresh resume_at re-arms it.
function onJobChanged(job, deps) {
  if (!job) return;
  if (job.resume_at) scheduleJob(job, deps);
  else cancel(job.id);
}
function onJobRemoved(jobId) { cancel(jobId); }

module.exports = { start, scheduleJob, cancel, onJobChanged, onJobRemoved };
