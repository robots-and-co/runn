'use strict';

// Contracts — expected income agreed in advance: who, how much, and when it
// recurs. Part of the finance-manager thread (docs/jobs/finance-manager/).
// LOCAL ONLY: nothing here touches a network, cloud, or AI/LLM. Plain
// deterministic records + arithmetic against ~/runn-data.
//
//   finance/contracts.json   one list: { version, contracts:[...] }
//
// A contract feeds EXPECTED income into the forecast. To avoid double-counting,
// an invoice can be stamped with `contract_id` + `contract_period` (YYYY-MM);
// the forecast then uses the real invoice for that month and drops the
// contract's estimate. The link is stored explicitly on the invoice (exact),
// though it reads to the operator as the contract's human label.
//
// Cadence is monthly to start (the only kind the forecast projects). An amount
// is what the client actually pays per period (GST-inclusive) — the forecast is
// about cash landing; GST for BAS comes from real bank transactions, not here.

const path = require('path');
const crypto = require('crypto');
const { DATA_ROOT, readJsonOr, atomicWriteJson, ensureDir } = require('./store');

const FINANCE_DIR = path.join(DATA_ROOT, 'finance');
const CONTRACTS_PATH = path.join(FINANCE_DIR, 'contracts.json');

const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function init() { await ensureDir(FINANCE_DIR); }

async function readStore() {
  const c = await readJsonOr(CONTRACTS_PATH, null);
  if (c && Array.isArray(c.contracts)) return c;
  return { version: 1, contracts: [] };
}
async function writeStore(store) { await atomicWriteJson(CONTRACTS_PATH, store); }

async function listContracts() {
  return (await readStore()).contracts;
}

// Normalise a YYYY-MM string; anything else → null (so a bad value never silently
// projects into the wrong month).
function ym(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}

// Fields the operator owns on a contract. Kept explicit so an unknown key in a
// PATCH body can't write junk onto the record.
function sanitize(patch, base = {}) {
  const out = { ...base };
  if ('client_id' in patch) out.client_id = patch.client_id || null;
  if ('label' in patch) out.label = String(patch.label || '').trim();
  if ('amount' in patch) out.amount = round2(patch.amount);
  if ('cadence' in patch) out.cadence = patch.cadence === 'monthly' ? 'monthly' : 'monthly'; // monthly only, for now
  if ('day_of_month' in patch) {
    const d = parseInt(patch.day_of_month, 10);
    out.day_of_month = Number.isInteger(d) && d >= 1 && d <= 31 ? d : null;
  }
  if ('start_month' in patch) out.start_month = ym(patch.start_month);
  if ('end_month' in patch) out.end_month = ym(patch.end_month); // null = ongoing
  if ('active' in patch) out.active = !!patch.active;
  if ('notes' in patch) out.notes = String(patch.notes || '');
  return out;
}

async function createContract(body = {}) {
  const label = String(body.label || '').trim();
  if (!label) { const e = new Error('contract label required'); e.status = 400; throw e; }
  const store = await readStore();
  const rec = sanitize(body, {
    id: 'ctr_' + crypto.randomBytes(8).toString('hex'),
    client_id: null,
    label,
    amount: 0,
    cadence: 'monthly',
    day_of_month: null,
    start_month: null,
    end_month: null,
    active: true,
    notes: '',
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  store.contracts.push(rec);
  await writeStore(store);
  return rec;
}

async function patchContract(id, patch = {}) {
  const store = await readStore();
  const c = store.contracts.find((x) => x.id === id);
  if (!c) { const e = new Error('contract not found'); e.status = 404; throw e; }
  Object.assign(c, sanitize(patch, c), { updated_at: nowIso(), id: c.id, created_at: c.created_at });
  await writeStore(store);
  return c;
}

async function deleteContract(id) {
  const store = await readStore();
  const before = store.contracts.length;
  store.contracts = store.contracts.filter((x) => x.id !== id);
  if (store.contracts.length === before) { const e = new Error('contract not found'); e.status = 404; throw e; }
  await writeStore(store);
  return { ok: true };
}

module.exports = {
  FINANCE_DIR,
  CONTRACTS_PATH,
  init,
  listContracts,
  createContract,
  patchContract,
  deleteContract,
};
