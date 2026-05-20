'use strict';

// One-time migration: lift client_* + invoice_* fields out of tag JSONs into a
// first-class `clients/` collection, and set client_id on any top-level card
// whose first tag matches a migrated tag. Idempotent — gated by
// settings.migrations.v1_clients.

const path = require('path');
const fsp = require('fs').promises;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'client';
}

async function run(deps) {
  const {
    DATA_ROOT, CARDS_DIR, TAGS_DIR, CLIENTS_DIR, SETTINGS_PATH,
    readJson, readJsonOr, atomicWriteJson, listCards,
    DEFAULT_SETTINGS, nowIso,
  } = deps;

  const settings = await readJsonOr(SETTINGS_PATH, DEFAULT_SETTINGS);
  if (settings.migrations && settings.migrations.v1_clients) return;

  const tagFiles = await fsp.readdir(TAGS_DIR).catch(() => []);
  const tagToClientId = new Map(); // tag-name → client-id

  for (const f of tagFiles) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const tagName = path.basename(f, '.json');
    let tag;
    try { tag = await readJson(path.join(TAGS_DIR, f)); } catch { continue; }

    const hasClient = !!(tag.client_name || tag.client_company || tag.client_contact ||
                         (tag.client_address_lines && tag.client_address_lines.length) ||
                         tag.invoice_prefix || tag.invoice_seq);
    if (!hasClient) continue;

    const clientId = slugify(tag.client_name || tagName);
    let finalId = clientId;
    let i = 2;
    while (tagToClientId.has(`__used:${finalId}`)) {
      finalId = `${clientId}-${i++}`;
    }
    tagToClientId.set(`__used:${finalId}`, true);
    tagToClientId.set(tagName, finalId);

    const client = {
      id: finalId,
      name: tag.client_name || tagName,
      company: tag.client_company || tag.client_name || '',
      contact: tag.client_contact || '',
      address_lines: Array.isArray(tag.client_address_lines) ? tag.client_address_lines : [],
      abn: tag.client_abn || '',
      currency: tag.currency || '',
      gst_rate: typeof tag.gst_rate === 'number' ? tag.gst_rate : null,
      rate_per_hour: typeof tag.rate_per_hour === 'number' ? tag.rate_per_hour : null,
      invoice_prefix: tag.invoice_prefix || tagName.toUpperCase(),
      invoice_seq: Number.isFinite(tag.invoice_seq) ? tag.invoice_seq : 1,
      migrated_from_tag: tagName,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await atomicWriteJson(path.join(CLIENTS_DIR, `${finalId}.json`), client);

    // Strip client_* / invoice_* fields from the tag JSON.
    const stripped = {};
    for (const [k, v] of Object.entries(tag)) {
      if (k.startsWith('client_') || k.startsWith('invoice_')) continue;
      stripped[k] = v;
    }
    stripped.tag = tagName;
    await atomicWriteJson(path.join(TAGS_DIR, f), stripped);

    console.log(`[runn] migrated tag '${tagName}' → client '${finalId}'`);
  }

  // Set client_id on top-level cards whose first tag matches a migrated tag.
  let cardsTouched = 0;
  for (const c of await listCards()) {
    if (c.parent_id) continue; // only top-level cards (projects)
    if (c.client_id) continue;
    const firstTag = (c.tags && c.tags[0]) || null;
    if (!firstTag) continue;
    const clientId = tagToClientId.get(firstTag);
    if (!clientId) continue;
    const merged = { ...c, client_id: clientId, updated_at: nowIso() };
    await atomicWriteJson(path.join(CARDS_DIR, `${c.id}.json`), merged);
    cardsTouched++;
  }
  if (cardsTouched) console.log(`[runn] set client_id on ${cardsTouched} project card(s)`);

  const updatedSettings = {
    ...settings,
    migrations: { ...(settings.migrations || {}), v1_clients: true },
  };
  await atomicWriteJson(SETTINGS_PATH, updatedSettings);
  console.log('[runn] migration v1_clients complete');
}

module.exports = { run };
