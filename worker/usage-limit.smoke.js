'use strict';

// Standalone smoke for the usage-limit parser + the auto-resume scheduler.
// Run from repo root:  node worker/usage-limit.smoke.js
//
// No network, no real Claude, no worker. Covers:
//   1. bridge.parseUsageLimit — the shapes we sniff out of Claude's output tail.
//   2. scheduler — arms a timer from resume_at and fires deps.resume once.

const assert = require('assert');
const { parseUsageLimit, limitFromExit } = require('./bridge');
const scheduler = require('./scheduler');

// ── 1. Parser ─────────────────────────────────────────────────────────────
function parserChecks() {
  // Machine form with an epoch in SECONDS.
  const epochSec = 1893456000; // 2030-01-01T00:00:00Z, comfortably in the future
  let r = parseUsageLimit(`stuff\nClaude AI usage limit reached|${epochSec}\nmore`);
  assert.ok(r, 'seconds-epoch should parse as a limit');
  assert.strictEqual(r.resetAt, epochSec * 1000, 'seconds → ms');

  // Machine form with an epoch already in MILLISECONDS.
  const epochMs = 1893456000000;
  r = parseUsageLimit(`usage limit reached | ${epochMs}`);
  assert.ok(r && r.resetAt === epochMs, 'ms-epoch passes through');

  // Human phrasing → a clock time on today/tomorrow.
  r = parseUsageLimit('Claude usage limit reached. Your limit will reset at 3pm (Australia/Melbourne).');
  assert.ok(r && typeof r.resetAt === 'number', '"reset at 3pm" gives a time');
  const d = new Date(r.resetAt);
  assert.strictEqual(d.getHours(), 15, '3pm → 15:00 local');
  assert.strictEqual(d.getMinutes(), 0);
  assert.ok(r.resetAt > Date.now(), 'reset time is in the future');

  // Human phrasing, 24h with minutes.
  r = parseUsageLimit('rate limit reached — resets at 09:30');
  assert.ok(r && new Date(r.resetAt).getHours() === 9 && new Date(r.resetAt).getMinutes() === 30);

  // Limit hit but no readable time → limited, resetAt null.
  r = parseUsageLimit('Claude AI usage limit reached. Please try again later.');
  assert.ok(r && r.resetAt === null, 'limit with no time → resetAt null');

  // The exact wording the installed CLI (v2.1.158) emits, no time → resetAt null.
  r = parseUsageLimit('Claude AI usage limit reached — check plan');
  assert.ok(r && r.resetAt === null, 'real CLI "usage limit reached — check plan" is detected');

  // A normal reply that merely mentions the words is NOT a limit (no "reached").
  assert.strictEqual(parseUsageLimit('I checked your usage limit settings for you.'), null,
    'incidental mention is not a limit');

  // Empty / junk.
  assert.strictEqual(parseUsageLimit(''), null);
  assert.strictEqual(parseUsageLimit(null), null);

  console.log('  parser: ok');
}

// ── 1b. Errored-gate (limitFromExit) ──────────────────────────────────────
// A limit only counts when the TURN FAILED — a non-zero exit, or an error
// result in the stream. A clean reply that merely mentions the words is not.
function gateChecks() {
  const msg = 'Claude AI usage limit reached — check plan';
  // Non-zero exit → real limit.
  assert.ok(limitFromExit(1, msg), 'non-zero exit with limit phrase → limited');
  // Clean exit, no error marker → treated as content, ignored.
  assert.strictEqual(limitFromExit(0, 'I looked at your usage limit reached earlier.'), null,
    'clean exit → limit phrase is just content');
  // Clean exit BUT an error result in the stream → real limit.
  const errStream = `{"type":"result","is_error":true,"result":"${msg}"}`;
  assert.ok(limitFromExit(0, errStream), 'is_error result → limited even on exit 0');
  // Not a limit at all → null regardless of exit.
  assert.strictEqual(limitFromExit(1, 'some other crash'), null, 'non-limit crash → null');
  console.log('  gate: ok');
}

// ── 2. Scheduler ──────────────────────────────────────────────────────────
async function schedulerChecks() {
  // Arms from resume_at and fires resume(jobId) exactly once, near the target.
  const fired = [];
  const deps = { listJobs: async () => [], resume: async (id) => { fired.push(id); } };
  const soon = new Date(Date.now() + 120).toISOString();
  scheduler.scheduleJob({ id: 'j_test', resume_at: soon }, deps);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(fired, ['j_test'], 'timer fired once for the parked job');

  // A cleared resume_at cancels the timer (onJobChanged with no resume_at).
  const fired2 = [];
  const deps2 = { listJobs: async () => [], resume: async (id) => { fired2.push(id); } };
  scheduler.scheduleJob({ id: 'j_cancel', resume_at: new Date(Date.now() + 120).toISOString() }, deps2);
  scheduler.onJobChanged({ id: 'j_cancel' /* no resume_at */ }, deps2);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(fired2, [], 'cleared resume_at cancels the timer');

  // start() rebuilds timers from disk (jobs listing).
  const fired3 = [];
  const deps3 = {
    listJobs: async () => [{ id: 'j_boot', resume_at: new Date(Date.now() + 120).toISOString() }],
    resume: async (id) => { fired3.push(id); },
  };
  await scheduler.start(deps3);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(fired3, ['j_boot'], 'start() re-armed the parked job');

  console.log('  scheduler: ok');
}

(async () => {
  parserChecks();
  gateChecks();
  await schedulerChecks();
  console.log('usage-limit smoke: ALL OK');
})().catch((err) => { console.error('SMOKE FAILED:', err.message); process.exit(1); });
