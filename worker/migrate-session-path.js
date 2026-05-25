'use strict';

// Migration v6_session_path: repair stale card.session_path pointers.
//
// v5_cwd_collapse relocated orphaned session jsonls between
// ~/.claude/projects/<slug>/ dirs (fs.rename) to align each card with its
// client's derived workspace — but it did NOT rewrite each card's stored
// absolute `session_path`. The GET /cards/:id/transcript handler trusts that
// field verbatim; once the file had moved, parseTranscript swallowed the
// ENOENT and old AI chats rendered as empty. (42 cards were affected — the
// exact set v5 relocated.)
//
// This repoints session_path at the jsonl's real home, located by session_id
// across every project slug. Only touches cards whose stored path no longer
// resolves AND whose jsonl is findable elsewhere by id; a genuinely-missing
// jsonl is left as-is.
//
// Idempotent — gated by settings.migrations.v6_session_path, and a no-op for
// any card whose stored path already resolves.

const path = require('path');
const fsp = require('fs').promises;

async function run(deps) {
  const {
    HOME, CARDS_DIR, ARCHIVE_DIR, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson, DEFAULT_SETTINGS, nowIso,
  } = deps;

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  if (settings.migrations && settings.migrations.v6_session_path) return;

  // Index every session jsonl by session_id across all project slugs.
  const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects');
  const byId = new Map(); // session_id → fullPath
  for (const slug of await fsp.readdir(CLAUDE_PROJ).catch(() => [])) {
    const dir = path.join(CLAUDE_PROJ, slug);
    let st;
    try { st = await fsp.stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      byId.set(f.slice(0, -'.jsonl'.length), path.join(dir, f));
    }
  }

  let repaired = 0, alreadyOk = 0, noFile = 0;
  for (const dir of [CARDS_DIR, ARCHIVE_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      let card;
      try { card = await readJson(path.join(dir, f)); } catch { continue; }
      if (!card.session_path || !card.session_id) continue;

      // Stored path still resolves → leave it (covers external-origin cards,
      // whose session_path is the source of truth for their cwd).
      let resolves = false;
      try { await fsp.access(card.session_path); resolves = true; } catch {}
      if (resolves) { alreadyOk++; continue; }

      const real = byId.get(card.session_id);
      if (!real || real === card.session_path) { noFile++; continue; }
      await atomicWriteJson(path.join(dir, f), { ...card, session_path: real, updated_at: nowIso() });
      console.log(`[runn] repaired session_path ${card.id} → ${path.basename(path.dirname(real))}/${card.session_id.slice(0, 8)}…`);
      repaired++;
    }
  }
  console.log(`[runn] v6_session_path: ${repaired} repaired, ${alreadyOk} already valid, ${noFile} stale with no jsonl on disk`);

  await atomicWriteJson(SETTINGS_PATH, {
    ...settings,
    migrations: { ...(settings.migrations || {}), v6_session_path: true },
  });
  console.log('[runn] migration v6_session_path complete');
}

module.exports = { run };

// Standalone runner: `node worker/migrate-session-path.js`. Lets the repair be
// applied to live data without a server restart (the transcript handler reads
// card.session_path fresh from disk per request, so rewriting the card files
// fixes the chats immediately). Mirrors server.js's path + helper conventions.
if (require.main === module) {
  const HOME = process.env.HOME;
  const DATA_ROOT = path.join(HOME, 'runn-data');
  const CARDS_DIR = path.join(DATA_ROOT, 'cards');
  const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'));
  const atomicWriteJson = async (p, data) => {
    const tmp = `${p}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, p);
  };
  run({
    HOME,
    CARDS_DIR,
    ARCHIVE_DIR: path.join(CARDS_DIR, 'archive'),
    SETTINGS_PATH: path.join(DATA_ROOT, 'settings.json'),
    readJson,
    readJsonOr: async (p, fb) => { try { return await readJson(p); } catch { return fb; } },
    atomicWriteJson,
    DEFAULT_SETTINGS: { personal_workspace: 'waz' },
    nowIso: () => new Date().toISOString(),
  }).catch((err) => { console.error('[runn] migration v6_session_path failed', err); process.exit(1); });
}
