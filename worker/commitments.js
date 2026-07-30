'use strict';

// Commitments — money you already know is going OUT that the bank hasn't seen
// yet: debts you owe now, and one-off purchases you're planning. The mirror of
// contracts.js (which is expected money IN). Part of the finance-manager thread
// (docs/jobs/finance-manager/).
// LOCAL ONLY: nothing here touches a network, cloud, or AI/LLM. Plain
// deterministic records + arithmetic against ~/runn-data.
//
//   finance/commitments.json   one list: { version, commitments:[...] }
//
// Two kinds, both hand-entered by the operator:
//   - 'purchase' — a one-off spend you're planning. `amount` is the cost,
//     `due_month` (YYYY-MM) the month it lands. Feeds forecast money-out once.
//   - 'debt' — money you owe right now. `balance` is what's still owed (it
//     lowers your total position immediately); `amount` is the monthly
//     repayment, projected out from `start_month` until the balance clears
//     (or `end_month`, whichever is first). A debt with no repayment just sits
//     as a balance you owe.
//
// These are things NOT already captured as "repeats monthly" bank rows — the
// operator owns the distinction, same as contracts vs real invoices. Amounts
// are GST-inclusive cash figures; BAS GST still comes only from real bank rows.

const path = require('path');
const crypto = require('crypto');
const { DATA_ROOT, readJsonOr, atomicWriteJson, ensureDir } = require('./store');

const FINANCE_DIR = path.join(DATA_ROOT, 'finance');
const COMMITMENTS_PATH = path.join(FINANCE_DIR, 'commitments.json');

const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function init() { await ensureDir(FINANCE_DIR); }

async function readStore() {
  const c = await readJsonOr(COMMITMENTS_PATH, null);
  if (c && Array.isArray(c.commitments)) return c;
  return { version: 1, commitments: [] };
}
async function writeStore(store) { await atomicWriteJson(COMMITMENTS_PATH, store); }

async function listCommitments() {
  return (await readStore()).commitments;
}

// Normalise a YYYY-MM string; anything else → null (so a bad value never silently
// projects into the wrong month).
function ym(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}

// Fields the operator owns. Kept explicit so an unknown key in a PATCH body
// can't write junk onto the record.
function sanitize(patch, base = {}) {
  const out = { ...base };
  if ('kind' in patch) out.kind = patch.kind === 'debt' ? 'debt' : 'purchase';
  if ('label' in patch) out.label = String(patch.label || '').trim();
  if ('amount' in patch) out.amount = round2(patch.amount);
  if ('balance' in patch) out.balance = round2(patch.balance);
  if ('due_month' in patch) out.due_month = ym(patch.due_month);       // one-off purchase
  if ('start_month' in patch) out.start_month = ym(patch.start_month); // debt repayment window
  if ('end_month' in patch) out.end_month = ym(patch.end_month);       // null = until paid off
  if ('active' in patch) out.active = !!patch.active;
  if ('notes' in patch) out.notes = String(patch.notes || '');
  return out;
}

async function createCommitment(body = {}) {
  const label = String(body.label || '').trim();
  if (!label) { const e = new Error('commitment label required'); e.status = 400; throw e; }
  const store = await readStore();
  const rec = sanitize(body, {
    id: 'cmt_' + crypto.randomBytes(8).toString('hex'),
    kind: 'purchase',
    label,
    amount: 0,
    balance: 0,
    due_month: null,
    start_month: null,
    end_month: null,
    active: true,
    notes: '',
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  store.commitments.push(rec);
  await writeStore(store);
  return rec;
}

async function patchCommitment(id, patch = {}) {
  const store = await readStore();
  const c = store.commitments.find((x) => x.id === id);
  if (!c) { const e = new Error('commitment not found'); e.status = 404; throw e; }
  Object.assign(c, sanitize(patch, c), { updated_at: nowIso(), id: c.id, created_at: c.created_at });
  await writeStore(store);
  return c;
}

async function deleteCommitment(id) {
  const store = await readStore();
  const before = store.commitments.length;
  store.commitments = store.commitments.filter((x) => x.id !== id);
  if (store.commitments.length === before) { const e = new Error('commitment not found'); e.status = 404; throw e; }
  await writeStore(store);
  return { ok: true };
}

module.exports = {
  FINANCE_DIR,
  COMMITMENTS_PATH,
  init,
  listCommitments,
  createCommitment,
  patchCommitment,
  deleteCommitment,
};
