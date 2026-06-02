'use strict';

// Invoice records — the issued side of billing. DRAFTS ARE NOT STORED: a draft
// is computed live in the frontend from a client's done-not-yet-invoiced jobs.
// Only when you *issue* does a record land here. See RUNN_PLAN.md section 4.
//
//   invoices/<id>.json   one issued (or paid) invoice
//
// Invoice numbers are hand-typed (v2 shares v1's read-only client files, so we
// can't bump a per-client sequence — auto-numbering is deferred). Issuing flips
// each linked job to `invoiced`; marking paid flips them to `paid`; voiding
// reverts them to `done` so they roll back into the next draft.

const path = require('path');
const fsp = require('fs').promises;
const { DATA_ROOT, readJson, readJsonOr, atomicWriteJson, ensureDir, listJsonIds } = require('./store');
const jobs = require('./jobs');

const INVOICES_DIR = path.join(DATA_ROOT, 'invoices');
const CLIENTS_DIR = path.join(DATA_ROOT, 'clients');
const SETTINGS_PATH = path.join(DATA_ROOT, 'settings.json');

const invoicePath = (id) => path.join(INVOICES_DIR, `${id}.json`);
const clientPath = (id) => path.join(CLIENTS_DIR, `${id}.json`);

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
async function fileExists(p) { return fsp.access(p).then(() => true, () => false); }

async function init() {
  await ensureDir(INVOICES_DIR);
}

async function readInvoice(id) { return readJson(invoicePath(id)); }
async function readInvoiceOr(id, fallback = null) {
  try { return await readInvoice(id); } catch { return fallback; }
}

async function listInvoices() {
  const ids = await listJsonIds(INVOICES_DIR);
  const out = [];
  for (const id of ids) {
    const inv = await readInvoiceOr(id);
    if (inv) out.push(inv);
  }
  // Newest issued first.
  out.sort((a, b) => String(b.issued_at).localeCompare(String(a.issued_at)));
  return out;
}

// Issue an invoice. body: { id, client_id, items:[{job_id,description,date,amount}],
// discount?, gst_rate?, notes?, issued_at?, due_at? }. Flips each linked job to
// `invoiced` and stamps invoice_id. Totals + the from/to/bank snapshot are
// frozen here so a later client/settings edit can't rewrite a sent invoice.
async function createInvoice(body) {
  if (!body.client_id) throw new Error('client required');
  if (!Array.isArray(body.items) || !body.items.length) throw new Error('at least one line item required');

  const id = String(body.id || '').trim();
  if (!id) throw new Error('invoice number required');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invoice number may only use letters, numbers, dot, dash, underscore');
  if (await fileExists(invoicePath(id))) throw new Error(`invoice ${id} already exists`);

  const settings = await readJsonOr(SETTINGS_PATH, {});
  const client = await readJsonOr(clientPath(body.client_id), null);
  if (!client) throw new Error('client not found');

  const items = body.items.map((it) => ({
    job_id: it.job_id || null,
    description: it.description || '',
    date: it.date || today(),
    amount: round2(it.amount),
  }));
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  const gstRate = (typeof body.gst_rate === 'number') ? body.gst_rate
                : (typeof client.gst_rate === 'number') ? client.gst_rate
                : (settings.default_gst_rate || 0);
  const discount = Math.min(subtotal, Math.max(0, round2(body.discount)));
  const taxable = round2(subtotal - discount);
  const gst = round2(taxable * gstRate);
  const total = round2(taxable + gst);
  const issued = body.issued_at || today();
  const due = body.due_at || addDays(issued, settings.default_due_days || 14);

  const inv = {
    id,
    client_id: body.client_id,
    issued_at: issued,
    due_at: due,
    items,
    subtotal,
    discount,
    gst_rate: gstRate,
    gst,
    total,
    paid: 0,
    balance: total,
    status: 'sent',
    notes: body.notes || '',
    snapshot: {
      from: {
        name: settings.business_name || '',
        address_lines: settings.business_address_lines || [],
        abn_acn: settings.business_abn_acn || '',
        logo_path: settings.logo_path || '',
      },
      to: {
        company: client.company || client.name || '',
        contact: client.contact || '',
        address_lines: client.address_lines || [],
        abn: client.abn || '',
      },
      bank: settings.bank || { bank: '', name: '', bsb: '', acc: '' },
      currency: client.currency || settings.currency || 'AUD',
      currency_symbol: settings.currency_symbol || '$',
      date_format: settings.date_format || 'DD/MM/YYYY',
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await atomicWriteJson(invoicePath(id), inv);
  for (const it of items) {
    if (!it.job_id) continue;
    try { await jobs.patchJob(it.job_id, { status: 'invoiced', invoice_id: id }); }
    catch (e) { console.error(`[runn] invoice ${id}: failed to flip job ${it.job_id}`, e.message); }
  }
  console.log(`[runn] issued invoice ${id} (${items.length} items, ${inv.snapshot.currency_symbol}${total})`);
  return inv;
}

// Only transition supported for now: mark a sent invoice paid (→ jobs to `paid`).
async function patchInvoice(id, patch = {}) {
  const inv = await readInvoice(id);
  if (patch.status === 'paid' && inv.status !== 'paid') {
    inv.status = 'paid';
    inv.paid = inv.total;
    inv.balance = 0;
    for (const it of inv.items) {
      if (!it.job_id) continue;
      try { await jobs.patchJob(it.job_id, { status: 'paid' }); }
      catch (e) { console.error(`[runn] invoice ${id}: failed to mark job ${it.job_id} paid`, e.message); }
    }
  }
  if (typeof patch.notes === 'string') inv.notes = patch.notes;
  inv.updated_at = nowIso();
  await atomicWriteJson(invoicePath(id), inv);
  return inv;
}

// Void: drop the record and roll its jobs back to `done` (clears invoice_id), so
// they reappear in the client's next draft. A clean undo for a mis-issued bill.
async function voidInvoice(id) {
  const inv = await readInvoiceOr(id);
  if (inv) {
    for (const it of inv.items) {
      if (!it.job_id) continue;
      try { await jobs.patchJob(it.job_id, { status: 'done', invoice_id: null }); }
      catch (e) { console.error(`[runn] void ${id}: failed to revert job ${it.job_id}`, e.message); }
    }
  }
  await fsp.rm(invoicePath(id), { force: true });
}

module.exports = {
  INVOICES_DIR,
  invoicePath,
  init,
  readInvoice,
  readInvoiceOr,
  listInvoices,
  createInvoice,
  patchInvoice,
  voidInvoice,
};
