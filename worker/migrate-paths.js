'use strict';

// Migration: rewrite stale card cwds to the correct client workspace under
// ~/projects/<slug>. Also backfills client.workspace on any client created
// before WORKSPACE PICKER landed (so the migration has a destination to
// point at). Idempotent — gated by settings.migrations.v4_paths. Mirrors
// migrate-clients.js / migrate-projects.js pattern.
//
// Path rewrite rules (cwd on the card):
//   - bare ~/runn-data  → ~/projects/<client.workspace>  (skip if no client)
//   - ~/runn-data/<x>/… → ~/projects/<x>                 (e.g. the stray lthcs/)
//   - ~/projects/easy/fleet/<x>/manager → ~/projects/easy-fleet-<x>-manager
//   - anything else (none, already correct, under ~/projects/<known>) → skip
//
// Path storage stays ABSOLUTE — relative-to-$HOME normalisation was originally
// part of HANDOFF.md step 2 but was deferred (would require resolving cwds on
// the read side everywhere). Picker already stores absolute; this aligns
// existing data with that convention.

const path = require('path');
const fsp = require('fs').promises;

async function run(deps) {
  const {
    HOME, CARDS_DIR, ARCHIVE_DIR, CLIENTS_DIR, WORKSPACES_ROOT, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson,
    ensureWorkspace, DEFAULT_SETTINGS, nowIso,
  } = deps;

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  if (settings.migrations && settings.migrations.v4_paths) return;

  const RUNN_DATA = path.join(HOME, 'runn-data');

  // ── Phase 1: backfill client.workspace for any client missing it ───────
  // ensureWorkspace mkdir's the dir + seeds a stub CLAUDE.md (idempotent),
  // returns the slug. Persists the slug back onto the client JSON.
  const clients = new Map(); // id → client
  const clientFiles = await fsp.readdir(CLIENTS_DIR).catch(() => []);
  for (const f of clientFiles) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    let cl;
    try { cl = await readJson(path.join(CLIENTS_DIR, f)); } catch { continue; }
    if (!cl.id) continue;
    if (!cl.workspace) {
      const slug = await ensureWorkspace(cl.name, cl.id);
      cl.workspace = slug;
      cl.updated_at = nowIso();
      await atomicWriteJson(path.join(CLIENTS_DIR, f), cl);
      console.log(`[runn] backfilled client.workspace='${slug}' on '${cl.id}' (${cl.name})`);
    }
    clients.set(cl.id, cl);
  }

  // ── Phase 2: index every card (live + archive) for parent-chain walking ──
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
  // client_id is on the root card; tasks inherit by walking parent_id.
  function rootClientId(c) {
    let cur = c, n = 0;
    while (cur && n++ < 16) {
      if (cur.client_id) return cur.client_id;
      if (!cur.parent_id) return null;
      cur = allCards.get(cur.parent_id);
    }
    return null;
  }

  // ── Phase 3: rewrite cwds per the rules above ──────────────────────────
  let touched = 0;
  for (const c of allCards.values()) {
    const cwd = (c.location && c.location.cwd) || '';
    if (!cwd) continue;
    const norm = cwd.replace(/\/+$/, '');

    let next = null;

    if (norm === RUNN_DATA) {
      // Bare runn-data: needs client to repoint
      const rid = rootClientId(c);
      const cl = rid ? clients.get(rid) : null;
      if (cl && cl.workspace) {
        next = path.join(WORKSPACES_ROOT, cl.workspace);
      }
      // No client → leave alone (user can repoint via picker)
    } else if (norm.startsWith(RUNN_DATA + '/')) {
      // Buried under runn-data/<subdir> — treat the first segment as the slug
      const tail = norm.slice(RUNN_DATA.length + 1);
      const slug = tail.split('/')[0];
      next = path.join(WORKSPACES_ROOT, slug);
    } else {
      // Slash-separated easy-fleet paths from before the workspace convention
      // settled. Hyphenate to the actual workspace dir names.
      const fixed = norm.replace(
        /^\/home\/waz\/projects\/easy\/fleet\/(endpoint|it)\/manager$/,
        '/home/waz/projects/easy-fleet-$1-manager'
      );
      if (fixed !== norm) next = fixed;
    }

    if (next && next !== cwd) {
      const merged = {
        ...c,
        location: { ...(c.location || {}), type: 'local', cwd: next },
        updated_at: nowIso(),
      };
      delete merged._dir;
      delete merged._file;
      await atomicWriteJson(path.join(c._dir, c._file), merged);
      console.log(`[runn] cwd: '${cwd}' → '${next}' on ${c.id}`);
      touched++;
    }
  }
  if (touched) console.log(`[runn] migration v4_paths: rewrote ${touched} card cwd(s)`);

  // ── Phase 4: persist the gate so we don't re-run ───────────────────────
  const updated = {
    ...settings,
    migrations: { ...(settings.migrations || {}), v4_paths: true },
  };
  await atomicWriteJson(SETTINGS_PATH, updated);
  console.log('[runn] migration v4_paths complete');
}

module.exports = { run };
