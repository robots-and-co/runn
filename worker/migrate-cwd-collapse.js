'use strict';

// Migration: collapse the per-project cwd model into a derived one.
//
// Before: each card had `location.cwd` set explicitly (via the picker), and
// the spawn flow trusted that field. Result: cards could drift away from
// their client's workspace, and changing a card's cwd silently orphaned its
// session jsonl in the old project slug.
//
// After: cwd is derived at spawn time — root.client.workspace. Every project
// has a client; "Personal" work goes under a `waz` client. The location.cwd
// field is stripped from cards.
//
// This migration:
//   0a. Create 4 new clients if missing: waz, Runn, EFEM, EFITM (all
//       non-billable; each owns one workspace dir under ~/projects/).
//   0b. Reassign 4 specific projects to their proper client: Personal → waz,
//       Runn Builder → Runn, EFEM → EFEM, EFITM → EFITM. These were all
//       under RC before; after this RC is an empty shell (kept for future
//       internal-but-not-product work).
//   1. For every card with session_id (live + archive, runn-origin):
//      - Compute target cwd from root.client.workspace
//      - Find the jsonl by session_id (scan every ~/.claude/projects/-* slug)
//      - If it lives in a different slug, mv it (skip if mtime within 5 min —
//        protects any in-flight session, including the one running this).
//   2. Strip the location field from every card (live + archive).
//   3. Persist settings.personal_workspace='waz' (defensive fallback) +
//      settings.migrations.v5_cwd_collapse.
//
// Idempotent — gated by settings.migrations.v5_cwd_collapse.

const NEW_CLIENTS = [
  { id: 'cl_waz',   name: 'waz',   workspace: 'waz',                          non_billable: true },
  { id: 'cl_runn',  name: 'Runn',  workspace: 'runn',                         non_billable: true },
  { id: 'cl_efem',  name: 'EFEM',  workspace: 'easy-fleet-endpoint-manager',  non_billable: true },
  { id: 'cl_efitm', name: 'EFITM', workspace: 'easy-fleet-it-manager',        non_billable: true },
];

const REASSIGNMENTS = [
  { card_id: 'c_mpex037w_7pot', client_id: 'cl_waz'   }, // Personal (live)
  { card_id: 'c_mpic9jds_8qfw', client_id: 'cl_runn'  }, // Runn Builder (live)
  { card_id: 'c_mpexzqj5_x7eh', client_id: 'cl_runn'  }, // Runn (archived; 44 live task kids inherit)
  { card_id: 'c_mpex2k6i_v5rr', client_id: 'cl_efem'  }, // EFEM (live)
  { card_id: 'c_mpex2g3u_ub59', client_id: 'cl_efitm' }, // EFITM (live)
];

const path = require('path');
const fsp = require('fs').promises;

const SAFE_MTIME_AGE_MS = 5 * 60 * 1000; // skip jsonls touched in last 5 min

async function run(deps) {
  const {
    HOME, CARDS_DIR, ARCHIVE_DIR, CLIENTS_DIR, WORKSPACES_ROOT, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson,
    ensureWorkspace, DEFAULT_SETTINGS, nowIso,
  } = deps;

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  if (settings.migrations && settings.migrations.v5_cwd_collapse) return;

  const personalSlug = settings.personal_workspace
    || (DEFAULT_SETTINGS && DEFAULT_SETTINGS.personal_workspace)
    || 'waz';

  // ── Phase 0a: create the 4 new clients (if missing) ───────────────────
  for (const spec of NEW_CLIENTS) {
    const p = path.join(CLIENTS_DIR, `${spec.id}.json`);
    try { await fsp.access(p); continue; } catch {} // already exists
    // Provision the workspace dir + stub CLAUDE.md
    await ensureWorkspace(spec.workspace, spec.id);
    const client = {
      id: spec.id,
      name: spec.name,
      company: '',
      address_lines: [],
      abn: '',
      currency: '',
      gst_rate: null,
      rate_per_hour: null,
      invoice_prefix: '',
      invoice_seq: 1,
      contact: '',
      wg_conf: '',
      wg_ip: '',
      ssh_user: '',
      workspace: spec.workspace,
      notes_md: '',
      non_billable: spec.non_billable === true,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await atomicWriteJson(p, client);
    console.log(`[runn] created client '${spec.id}' (${spec.name}) → workspace '${spec.workspace}'`);
  }

  // ── Phase 0b: reassign specific projects to their proper clients ──────
  for (const r of REASSIGNMENTS) {
    let p = path.join(CARDS_DIR, `${r.card_id}.json`);
    let card;
    try { card = await readJson(p); }
    catch {
      p = path.join(ARCHIVE_DIR, `${r.card_id}.json`);
      try { card = await readJson(p); } catch { continue; }
    }
    if (card.client_id === r.client_id) continue;
    const merged = { ...card, client_id: r.client_id, updated_at: nowIso() };
    await atomicWriteJson(p, merged);
    console.log(`[runn] reassigned ${r.card_id} (${(card.title||'').slice(0,40)}) → client ${r.client_id}`);
  }

  // ── Phase 1: index all clients (id → workspace slug) ───────────────────
  const clients = new Map();
  const clientFiles = await fsp.readdir(CLIENTS_DIR).catch(() => []);
  for (const f of clientFiles) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const cl = await readJson(path.join(CLIENTS_DIR, f));
      if (cl.id) clients.set(cl.id, cl);
    } catch {}
  }

  // ── Phase 3: index all cards (live + archive) for parent-chain walking ──
  const allCards = new Map();
  for (const dir of [CARDS_DIR, ARCHIVE_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const c = await readJson(path.join(dir, f));
        allCards.set(c.id, { ...c, _dir: dir, _file: f });
      } catch {}
    }
  }
  function rootOf(c) {
    let cur = c, n = 0;
    while (cur && cur.parent_id && n++ < 16) cur = allCards.get(cur.parent_id);
    return cur;
  }
  function targetCwdFor(card) {
    if (card.origin === 'external') return null; // adopted, leave alone
    const root = rootOf(card) || card;
    if (root.client_id) {
      const cl = clients.get(root.client_id);
      if (cl && cl.workspace) return path.join(WORKSPACES_ROOT, cl.workspace);
    }
    return path.join(WORKSPACES_ROOT, personalSlug);
  }
  function cwdToSlug(cwd) {
    return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  }

  // ── Phase 4: scan ~/.claude/projects/ for every jsonl, build session map ──
  const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects');
  const sessionFiles = new Map(); // session_id → { fullPath, slug, mtime }
  for (const slug of await fsp.readdir(CLAUDE_PROJ).catch(() => [])) {
    const dir = path.join(CLAUDE_PROJ, slug);
    let stat;
    try { stat = await fsp.stat(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const sessId = f.slice(0, -'.jsonl'.length);
      let s;
      try { s = await fsp.stat(path.join(dir, f)); } catch { continue; }
      sessionFiles.set(sessId, { fullPath: path.join(dir, f), slug, mtime: s.mtimeMs });
    }
  }

  // ── Phase 5: relocate orphaned jsonls ─────────────────────────────────
  let moved = 0, skippedLive = 0, alreadyOk = 0, noFile = 0;
  const now = Date.now();
  for (const c of allCards.values()) {
    if (!c.session_id) continue;
    const target = targetCwdFor(c);
    if (!target) continue; // external
    const targetSlug = cwdToSlug(target);
    const sf = sessionFiles.get(c.session_id);
    if (!sf) { noFile++; continue; }
    if (sf.slug === targetSlug) { alreadyOk++; continue; }
    if (now - sf.mtime < SAFE_MTIME_AGE_MS) {
      console.log(`[runn] skipping live session ${c.session_id.slice(0,8)}… (mtime ${Math.round((now-sf.mtime)/1000)}s ago) — relocate after this restart`);
      skippedLive++;
      continue;
    }
    const targetDir = path.join(CLAUDE_PROJ, targetSlug);
    await fsp.mkdir(targetDir, { recursive: true });
    const dest = path.join(targetDir, `${c.session_id}.jsonl`);
    await fsp.rename(sf.fullPath, dest);
    console.log(`[runn] mv ${sf.slug}/${c.session_id.slice(0,8)}… → ${targetSlug}/`);
    moved++;
  }
  console.log(`[runn] jsonl moves: ${moved} relocated, ${alreadyOk} already in place, ${skippedLive} live (skipped), ${noFile} card has session_id but no jsonl on disk`);

  // ── Phase 6: strip card.location from every card on disk ──────────────
  let stripped = 0;
  for (const c of allCards.values()) {
    if (!c.location) continue;
    const { _dir, _file, location, ...rest } = c;
    rest.updated_at = nowIso();
    await atomicWriteJson(path.join(_dir, _file), rest);
    stripped++;
  }
  if (stripped) console.log(`[runn] stripped location field from ${stripped} card(s) — cwd is now derived at spawn time`);

  // ── Phase 7: persist personal_workspace + gate ────────────────────────
  const updated = {
    ...settings,
    personal_workspace: personalSlug,
    migrations: { ...(settings.migrations || {}), v5_cwd_collapse: true },
  };
  await atomicWriteJson(SETTINGS_PATH, updated);
  console.log('[runn] migration v5_cwd_collapse complete');
}

module.exports = { run };
