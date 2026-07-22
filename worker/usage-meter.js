'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Claude usage meter — a "good enough" live gauge of how much of the account's
// rolling 5-hour Claude allowance has been spent.
//
// Anthropic does NOT publish the exact allowance, and it's a weighted *cost*
// across models (Opus counts far more than Haiku), not a raw token count. So we
// approximate: weight the token counts already sitting in every session
// transcript by a rough per-model price, sum them over the current 5-hour
// window, and divide by a ceiling. The ceiling self-calibrates — see below.
//
// This is an ESTIMATE. The pricing table is a proxy for how Anthropic weights
// usage; the whole thing rescales cleanly when the real usage API arrives (swap
// snapshot()'s ceiling/used for the API's numbers and keep the frontend gauge).
//
// The ceiling (denominator):
//   • Before any real limit hit: the busiest 5-hour window ever seen in the
//     transcripts (`maxBlockCost`). Intuitive ("% of my heaviest-ever session")
//     and never wildly wrong.
//   • After a real limit hit: the server records that window's measured cost as
//     the true ceiling (settings.usage_ceiling_cost) — see parkForUsageLimit.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const SESSION_MS = 5 * 60 * 60 * 1000; // Anthropic's rolling session window ≈ 5h.

// Rough per-model price per MILLION tokens, USD. These mirror published list
// prices for the 4.x family and act only as *relative weights* — the absolute
// dollars don't matter because the gauge is a ratio to a self-calibrated
// ceiling. Update here if prices move; the gauge just rescales.
const PRICES = {
  opus:   { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { in: 1,  out: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
};

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return PRICES.haiku;
  if (m.includes('sonnet')) return PRICES.sonnet;
  return PRICES.opus; // opus + unknown → conservative (heaviest) weight
}

function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return 'other';
}

// Weighted cost (USD estimate) of one assistant message's usage block.
function costOf(usage, model) {
  if (!usage) return 0;
  const p = priceFor(model);
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  return (inp * p.in + out * p.out + cw * p.cacheWrite + cr * p.cacheRead) / 1e6;
}

// ── Per-file cache ───────────────────────────────────────────
// Reading every transcript on each keystroke would be wasteful, so we cache each
// file's parsed usage records keyed by (mtime,size). A file only needs re-reading
// when it grows. Records are the deduped usage rows: { ts, id, cost, family }.
const fileCache = new Map(); // absolutePath → { mtimeMs, size, recs: [...] }

async function parseFile(file) {
  const recs = [];
  let lineNo = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    const msg = ev.message;
    if (!msg || !msg.usage) continue;
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    // Claude Code writes the same assistant message across several lines (text →
    // tool_use → text), each carrying the SAME cumulative usage + message.id. Key
    // on message.id so we count each API response once; fall back to a per-line
    // key when an id is missing so distinct rows aren't collapsed.
    const id = msg.id || `${file}#${lineNo}`;
    recs.push({ ts, id, cost: costOf(msg.usage, msg.model), family: familyOf(msg.model) });
  }
  return recs;
}

// Refresh one file's cache entry; returns its records (from cache if unchanged).
async function refreshFile(file) {
  let st;
  try { st = await fsp.stat(file); } catch { fileCache.delete(file); return []; }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.recs;
  const recs = await parseFile(file);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, recs });
  return recs;
}

// List every *.jsonl under the sessions root (depth 2: <cwd-slug>/<id>.jsonl),
// optionally only those touched since `sinceMs` (mtime) to bound the work.
async function listTranscripts(root, sinceMs) {
  const out = [];
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    let files;
    try { files = await fsp.readdir(sub, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const full = path.join(sub, f.name);
      if (sinceMs) {
        try { if ((await fsp.stat(full)).mtimeMs < sinceMs) continue; } catch { continue; }
      }
      out.push(full);
    }
  }
  return out;
}

// ── Block maths ──────────────────────────────────────────────
// Walk deduped records ascending. A new 5-hour block starts when we've run past
// the current block's start, OR after a ≥5h gap of inactivity. Returns the
// ACTIVE block (the one covering `now`, if any) plus the heaviest block ever.
function computeBlocks(records, now) {
  const recs = records.slice().sort((a, b) => a.ts - b.ts);
  let blockStart = null, lastTs = null, blockCost = 0;
  let maxBlockCost = 0;
  const blocks = []; // { start, cost }
  for (const r of recs) {
    if (blockStart === null || r.ts - blockStart >= SESSION_MS || r.ts - lastTs >= SESSION_MS) {
      if (blockStart !== null) blocks.push({ start: blockStart, cost: blockCost });
      blockStart = r.ts; blockCost = 0;
    }
    blockCost += r.cost;
    lastTs = r.ts;
    if (blockCost > maxBlockCost) maxBlockCost = blockCost;
  }
  if (blockStart !== null) blocks.push({ start: blockStart, cost: blockCost });

  const last = blocks[blocks.length - 1] || null;
  const active = !!last && now < last.start + SESSION_MS;
  const perFamily = {};
  if (active) {
    for (const r of recs) {
      if (r.ts >= last.start && r.ts < last.start + SESSION_MS) {
        perFamily[r.family] = (perFamily[r.family] || 0) + r.cost;
      }
    }
  }
  return {
    active,
    blockStart: active ? last.start : null,
    resetAt: active ? last.start + SESSION_MS : null,
    usedCost: active ? last.cost : 0,
    maxBlockCost,
    perFamily,
  };
}

// Busiest 5-hour block ever recorded, scanning ALL transcripts. This is the
// uncalibrated default ceiling. It's a full-history scan, so callers should run
// it occasionally (boot + on a slow interval) and cache the result, NOT on every
// gauge tick. Returns 0 on an empty box.
async function historicalMaxBlockCost(root, now = Date.now()) {
  const all = await listTranscripts(root, 0);
  const byId = new Map();
  for (const file of all) {
    for (const r of await refreshFile(file)) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  return computeBlocks([...byId.values()], now).maxBlockCost;
}

// ── Public snapshot ──────────────────────────────────────────
// Gather deduped records across recent transcripts, compute the active block,
// and return a gauge-ready payload. The caller supplies `ceiling` (the calibrated
// cost from a real limit hit, else the busiest-ever from historicalMaxBlockCost)
// and whether it's calibrated. Only the last ~2 windows of files are read, so
// this is cheap enough to run on every transcript change.
async function snapshot(root, { now = Date.now(), ceiling = 0, calibrated = false } = {}) {
  const recent = await listTranscripts(root, now - 2 * SESSION_MS);
  const byId = new Map();
  for (const file of recent) {
    for (const r of await refreshFile(file)) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  const b = computeBlocks([...byId.values()], now);
  // Never let the ceiling sit below what we've already spent this window — a
  // stale/low calibration shouldn't peg the gauge at 100% and hide real headroom.
  const eff = Math.max(ceiling || 0, b.usedCost, b.maxBlockCost, 0.01);
  const pct = Math.max(0, Math.min(100, (b.usedCost / eff) * 100));
  return {
    pct: Math.round(pct * 10) / 10,
    usedCost: Math.round(b.usedCost * 100) / 100,
    ceilingCost: Math.round(eff * 100) / 100,
    calibrated: !!calibrated && ceiling >= b.usedCost,
    active: b.active,
    blockStart: b.blockStart ? new Date(b.blockStart).toISOString() : null,
    resetAt: b.resetAt ? new Date(b.resetAt).toISOString() : null,
    perFamily: b.perFamily,
    windowMinutes: Math.round(SESSION_MS / 60000),
    updatedAt: new Date(now).toISOString(),
  };
}

// Measure the CURRENT active-block cost right now — used by the server at a real
// limit hit to record the true ceiling (self-calibration).
async function currentBlockCost(root, now = Date.now()) {
  const recent = await listTranscripts(root, now - 2 * SESSION_MS);
  const byId = new Map();
  for (const file of recent) {
    for (const r of await refreshFile(file)) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  return computeBlocks([...byId.values()], now).usedCost;
}

module.exports = {
  SESSION_MS, PRICES, costOf, priceFor, familyOf,
  computeBlocks, snapshot, currentBlockCost, historicalMaxBlockCost,
  refreshFile, listTranscripts,
  _fileCache: fileCache,
};

// ── Self-test / CLI report ───────────────────────────────────
// `node worker/usage-meter.js` prints a plain-English report against the real
// transcripts so the maths can be eyeballed before wiring it into the server.
if (require.main === module) {
  (async () => {
    const root = path.join(process.env.HOME || require('os').homedir(), '.claude', 'projects');
    const now = Date.now();
    // Full history scan for the busiest-ever ceiling + a block timeline.
    const all = await listTranscripts(root, 0);
    const byId = new Map();
    for (const f of all) for (const r of await refreshFile(f)) if (!byId.has(r.id)) byId.set(r.id, r);
    const recs = [...byId.values()];
    const b = computeBlocks(recs, now);
    const snap = await snapshot(root, { now, ceiling: b.maxBlockCost, calibrated: false });

    const money = (n) => '$' + n.toFixed(2);
    console.log(`transcripts scanned : ${all.length} files, ${recs.length} usage rows`);
    console.log(`busiest-ever 5h block: ${money(b.maxBlockCost)} (weighted estimate)`);
    console.log('');
    if (snap.active) {
      console.log(`ACTIVE window        : started ${new Date(snap.blockStart).toLocaleString()}`);
      console.log(`resets around        : ${new Date(snap.resetAt).toLocaleString()}`);
      console.log(`used this window     : ${money(snap.usedCost)}`);
      console.log(`ceiling (busiest-ever): ${money(snap.ceilingCost)}`);
      console.log(`GAUGE                : ${snap.pct}%  ${'█'.repeat(Math.round(snap.pct / 5)).padEnd(20, '·')}`);
      console.log(`by model             :`, snap.perFamily);
    } else {
      console.log('no active window — nothing spent in the last 5 hours.');
      console.log(`ceiling (busiest-ever): ${money(snap.ceilingCost)}`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
