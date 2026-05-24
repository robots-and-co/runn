'use strict';

// One-time migration: create a default "General" project per existing client
// and assign every card with a client_id (and no project_id) to it. Idempotent
// — gated by settings.migrations.v2_projects. Mirrors migrate-clients.js.

const path = require('path');
const fsp = require('fs').promises;

function mintProjectId() {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function run(deps) {
  const {
    CARDS_DIR, ARCHIVE_DIR, CLIENTS_DIR, PROJECTS_DIR, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson,
    DEFAULT_SETTINGS, nowIso,
  } = deps;

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  if (settings.migrations && settings.migrations.v2_projects) return;

  await fsp.mkdir(PROJECTS_DIR, { recursive: true });

  // For every client, create a "General" project. Skip clients that already
  // have at least one project on disk (allows re-running after a partial run).
  const existingProjects = await fsp.readdir(PROJECTS_DIR).catch(() => []);
  const clientHasProject = new Set();
  for (const f of existingProjects) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const p = await readJson(path.join(PROJECTS_DIR, f));
      if (p.client_id) clientHasProject.add(p.client_id);
    } catch {}
  }

  const generalByClient = new Map(); // client_id → project_id
  const clientFiles = await fsp.readdir(CLIENTS_DIR).catch(() => []);
  for (const f of clientFiles) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    let client;
    try { client = await readJson(path.join(CLIENTS_DIR, f)); } catch { continue; }
    if (!client.id) continue;
    if (clientHasProject.has(client.id)) continue;

    const id = mintProjectId();
    const project = {
      id,
      client_id: client.id,
      name: 'General',
      color: null,
      status: 'active',
      sort_order: Date.now(),
      notes_md: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await atomicWriteJson(path.join(PROJECTS_DIR, `${id}.json`), project);
    generalByClient.set(client.id, id);
    console.log(`[runn] created default project '${id}' for client '${client.id}'`);
  }

  // Backfill project_id on cards: anything with a client_id and no project_id
  // gets that client's General project. Walks both live and archived cards so
  // historical invoices remain consistent.
  let cardsTouched = 0;
  for (const dir of [CARDS_DIR, ARCHIVE_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const fp = path.join(dir, f);
      let c;
      try { c = await readJson(fp); } catch { continue; }
      if (!c.client_id) continue;
      if (c.project_id) continue;
      // If we just-created a General for this client, use it. Otherwise look
      // for any existing project belonging to the client (covers re-runs).
      let projectId = generalByClient.get(c.client_id);
      if (!projectId) {
        for (const pf of existingProjects) {
          if (!pf.endsWith('.json') || pf.endsWith('.tmp')) continue;
          try {
            const p = await readJson(path.join(PROJECTS_DIR, pf));
            if (p.client_id === c.client_id) { projectId = p.id; break; }
          } catch {}
        }
      }
      if (!projectId) continue;
      await atomicWriteJson(fp, { ...c, project_id: projectId, updated_at: nowIso() });
      cardsTouched++;
    }
  }
  if (cardsTouched) console.log(`[runn] set project_id on ${cardsTouched} card(s)`);

  const updatedSettings = {
    ...settings,
    migrations: { ...(settings.migrations || {}), v2_projects: true },
  };
  await atomicWriteJson(SETTINGS_PATH, updatedSettings);
  console.log('[runn] migration v2_projects complete');
}

module.exports = { run };
