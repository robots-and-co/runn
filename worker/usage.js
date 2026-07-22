'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Real Claude usage — the exact numbers the `/usage` command shows in the
// Claude Code terminal, not an estimate.
//
// Anthropic exposes them at GET https://api.anthropic.com/api/oauth/usage:
// a `five_hour` and `seven_day` block, each with a `utilization` percentage and
// a `resets_at` timestamp. We just read those. No pricing table, no ceiling
// guessing (that was worker/usage-meter.js, now retired).
//
// Auth reuses the login token Claude Code already stores at
// ~/.claude/.credentials.json (`claudeAiOauth.accessToken`). We re-read that file
// on every refresh so we always use the token Claude Code silently rotates — we
// never write it or refresh it ourselves. If the file is missing, the token has
// expired, or the call fails, snapshot() returns { ok:false } and the gauge just
// hides rather than showing anything wrong.
// ─────────────────────────────────────────────────────────────────────────

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 12000;
const TTL_MS = 45 * 1000;          // reuse a fetched snapshot for this long
const GRACE_MS = 5 * 60 * 1000;    // keep serving the last good one this long on error

// Claude Code sends this header on the same request; mirror it so we look like the
// CLI to the endpoint. The version is cosmetic — the endpoint doesn't gate on it.
const USER_AGENT = 'claude-cli/2.1.158';

let cache = null; // { at: epochMs, snap }

async function readToken() {
  const raw = await fsp.readFile(CREDENTIALS, 'utf8');
  const o = (JSON.parse(raw) || {}).claudeAiOauth || {};
  if (!o.accessToken) throw new Error('no accessToken in credentials');
  // expiresAt is epoch ms; a clearly-expired token would just 401, so skip early.
  if (o.expiresAt && Date.now() > Number(o.expiresAt)) throw new Error('token expired');
  return o.accessToken;
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

// Reduce the endpoint's payload to the few fields the gauge needs.
function normalize(raw, now) {
  const fh = (raw && raw.five_hour) || {};
  const sd = (raw && raw.seven_day) || {};
  const pct = clampPct(fh.utilization);
  return {
    ok: true,
    active: pct > 0,               // hide the strip on a fresh/empty window
    pct,
    resetAt: fh.resets_at || null,
    weeklyPct: clampPct(sd.utilization),
    weeklyResetAt: sd.resets_at || null,
    source: 'api',
    updatedAt: new Date(now).toISOString(),
  };
}

async function fetchFresh(now) {
  const token = await readToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  return normalize(await res.json(), now);
}

// A usage snapshot, served from cache when it's younger than TTL_MS. Never throws:
// on any failure it returns the last good snapshot (for a short grace window), else
// { ok:false, active:false } so the gauge degrades quietly.
async function snapshot({ force = false, now = Date.now() } = {}) {
  if (!force && cache && now - cache.at < TTL_MS) return cache.snap;
  try {
    const snap = await fetchFresh(now);
    cache = { at: now, snap };
    return snap;
  } catch (err) {
    if (cache && now - cache.at < GRACE_MS) return cache.snap;
    return {
      ok: false,
      active: false,
      source: 'api',
      error: String((err && err.message) || err),
      updatedAt: new Date(now).toISOString(),
    };
  }
}

module.exports = { snapshot, _endpoint: ENDPOINT, _credentials: CREDENTIALS };

// ── CLI: `node worker/usage.js` prints the real gauge, for eyeballing ────────
if (require.main === module) {
  snapshot({ force: true })
    .then((u) => {
      if (!u.ok) { console.log('usage unavailable:', u.error); return; }
      const reset = u.resetAt ? new Date(u.resetAt).toLocaleString() : '—';
      const wkReset = u.weeklyResetAt ? new Date(u.weeklyResetAt).toLocaleString() : '—';
      console.log(`5-hour session : ${u.pct}%  ${'█'.repeat(Math.round(u.pct / 5)).padEnd(20, '·')}  resets ${reset}`);
      console.log(`this week      : ${u.weeklyPct}%  ${'█'.repeat(Math.round(u.weeklyPct / 5)).padEnd(20, '·')}  resets ${wkReset}`);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
