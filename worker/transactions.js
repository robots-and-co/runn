'use strict';

// Bank transactions — the money-in/money-out ledger imported from a bank CSV.
// Job 1 of the finance-manager thread (docs/jobs/finance-manager/). LOCAL ONLY:
// nothing here touches a network, a cloud service, or any AI/LLM. It is plain
// deterministic parsing + arithmetic against ~/runn-data. Treat "a number left
// the machine" as a defect.
//
//   finance/transactions.json   one ledger: { version, transactions:[...] }
//
// Unlike invoices (file-per-record), a personal ledger is naturally one ordered
// list, and reconciliation/forecast want to scan it whole — so it lives in a
// single atomically-written file. Imports are user-driven and single-writer.
//
// Expected CSV header (case/spacing tolerant):
//   Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
// Serial is the de-dup key (re-importing the same file adds nothing); Balance
// drives an integrity check that the imported batch has no gaps.

const path = require('path');
const crypto = require('crypto');
const { DATA_ROOT, readJsonOr, atomicWriteJson, ensureDir } = require('./store');

const FINANCE_DIR = path.join(DATA_ROOT, 'finance');
const LEDGER_PATH = path.join(FINANCE_DIR, 'transactions.json');
const CATEGORIES_PATH = path.join(FINANCE_DIR, 'categories.json');
const RULES_PATH = path.join(FINANCE_DIR, 'rules.json');

const CANONICAL_HEADER = 'Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial';

// A few sensible starter categories the operator can extend or delete — not a
// fixed taxonomy. kind: 'in' (money in), 'out' (money out), 'both'.
const DEFAULT_CATEGORIES = [
  { id: 'client-income', name: 'Client income', kind: 'in' },
  { id: 'other-income',  name: 'Other income',  kind: 'in' },
  { id: 'utilities',     name: 'Utilities',      kind: 'out' },
  { id: 'software',      name: 'Software',        kind: 'out' },
  { id: 'supplies',      name: 'Supplies',        kind: 'out' },
  { id: 'bank-fees',     name: 'Bank fees',       kind: 'out' },
];

const nowIso = () => new Date().toISOString();
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

async function init() { await ensureDir(FINANCE_DIR); }

async function readLedger() {
  const l = await readJsonOr(LEDGER_PATH, null);
  if (l && Array.isArray(l.transactions)) {
    if (l.opening_balance === undefined) l.opening_balance = null; // set once, on the first import
    if (l.opening_date === undefined) l.opening_date = null;
    return l;
  }
  return { version: 1, transactions: [], opening_balance: null, opening_date: null };
}

async function getMeta() {
  const l = await readLedger();
  return {
    count: l.transactions.length,
    opening_balance: l.opening_balance ?? null,
    opening_date: l.opening_date ?? null,
  };
}
async function writeLedger(l) { await atomicWriteJson(LEDGER_PATH, l); }

async function listTransactions() {
  const l = await readLedger();
  return l.transactions;
}

// ── CSV parsing (RFC4180-ish: quoted fields may contain commas/newlines) ─────
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const s = String(text).replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore CR; handled with LF */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "$1,234.50" → 1234.5 ; "" → 0
function num(s) {
  const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// Normalise to YYYY-MM-DD. Handles ISO and DD/MM/YYYY (AU bank default). Leaves
// anything unrecognised untouched so a weird row is still visible, not dropped.
function parseDate(s) {
  const raw = String(s || '').trim();
  let m;
  if ((m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // DD/MM/YYYY
  }
  return raw;
}

const norm = (x) => String(x == null ? '' : x).trim().toLowerCase();

// Map the header row to column indices, tolerant of case + surrounding spaces.
function headerIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => { if (idx[norm(h)] === undefined) idx[norm(h)] = i; });
  const at = (name) => (idx[norm(name)] === undefined ? -1 : idx[norm(name)]);
  return {
    account: at('Bank Account'),
    date: at('Date'),
    narrative: at('Narrative'),
    debit: at('Debit Amount'),
    credit: at('Credit Amount'),
    balance: at('Balance'),
    bank_category: at('Categories'),
    serial: at('Serial'),
  };
}

// Stable identity for a row. Serial (per account) when present; otherwise a
// content hash so a serial-less export still de-dupes sensibly.
function dedupKey(t) {
  return t.serial
    ? `${t.account}|s:${t.serial}`
    : `${t.account}|c:${t.date}|${t.narrative}|${t.debit}|${t.credit}|${t.balance}`;
}
function txnId(key) {
  return 'txn_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// Parse CSV text into normalised (not yet de-duped or saved) transaction rows.
function parseTransactions(csv, accountOverride) {
  const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!rows.length) return { error: 'file is empty' };
  const idx = headerIndex(rows[0]);
  if (idx.date < 0 || idx.narrative < 0 || (idx.debit < 0 && idx.credit < 0)) {
    return { error: `unexpected columns — expected header: ${CANONICAL_HEADER}` };
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (j) => (j >= 0 && j < r.length ? String(r[j]).trim() : '');
    const debit = round2(num(get(idx.debit)));
    const credit = round2(num(get(idx.credit)));
    const t = {
      account: accountOverride || get(idx.account) || '',
      date: parseDate(get(idx.date)),
      date_raw: get(idx.date),
      narrative: get(idx.narrative),
      debit,
      credit,
      amount: round2(credit - debit), // signed: + money in, - money out
      balance: idx.balance >= 0 && get(idx.balance) !== '' ? round2(num(get(idx.balance))) : null,
      bank_category: get(idx.bank_category), // hidden in UI; kept for completeness
      serial: get(idx.serial),               // hidden in UI; the de-dup key
    };
    t._key = dedupKey(t);
    t.id = txnId(t._key);
    out.push(t);
  }
  return { rows: out };
}

// Integrity check: within the imported batch, each row's Balance must equal the
// previous row's Balance +credit -debit. If it breaks, a row is likely missing —
// surface it rather than silently accepting a gap. Rows are checked in file order
// (the order the bank exported them), which is the order the running balance moves.
function balanceCheck(rows, opening) {
  const withBal = rows.filter((r) => r.balance != null);
  // When an opening balance is given (the first import), also anchor the very
  // first row to it: opening + first row's movement should equal its Balance.
  if (opening != null && withBal.length) {
    const first = withBal[0];
    const expected = round2(Number(opening) + first.amount);
    if (Math.abs(expected - first.balance) > 0.005) {
      return {
        ok: false,
        checked: 1,
        message: `the opening balance ${round2(opening)} doesn't line up with the first row "${first.narrative}" (${first.date}): expected ${expected}, file says ${first.balance}.`,
      };
    }
  }
  if (withBal.length < 2) {
    return {
      ok: true,
      checked: withBal.length,
      message: (opening != null && withBal.length) ? 'opening balance lines up with the first row' : 'no running balance to verify',
    };
  }
  for (let i = 1; i < withBal.length; i++) {
    const prev = withBal[i - 1], cur = withBal[i];
    const expected = round2(prev.balance + cur.credit - cur.debit);
    if (Math.abs(expected - cur.balance) > 0.005) {
      return {
        ok: false,
        checked: i + 1,
        message: `running balance breaks around "${cur.narrative}" (${cur.date}): expected ${expected}, file says ${cur.balance}. A row may be missing between imports.`,
      };
    }
  }
  return {
    ok: true,
    checked: withBal.length,
    message: `running balance matches across all ${withBal.length} rows` + (opening != null ? ' (and the opening balance)' : ''),
  };
}

// Import (or preview) a CSV. body: { csv, account?, dryRun? }.
// Returns a summary; when dryRun is falsy and there are new rows, appends + saves.
async function importCsv({ csv, account, dryRun, opening_balance, opening_date } = {}) {
  if (typeof csv !== 'string' || !csv.trim()) { const e = new Error('no CSV text provided'); e.status = 400; throw e; }
  const parsed = parseTransactions(csv, account);
  if (parsed.error) { const e = new Error(parsed.error); e.status = 400; throw e; }

  const incoming = parsed.rows;
  const ledger = await readLedger();
  const isInitial = ledger.transactions.length === 0;

  // Opening balance is a one-off: set on the very first import only. Prefer an
  // explicit value; otherwise suggest it from the first row (its Balance minus
  // that row's own movement = the balance that existed before it).
  const firstWithBal = incoming.find((r) => r.balance != null);
  const openingSuggested = firstWithBal ? round2(firstWithBal.balance - firstWithBal.amount) : null;
  const explicitOpening = (opening_balance != null && opening_balance !== '' && Number.isFinite(Number(opening_balance)))
    ? round2(Number(opening_balance)) : null;
  const opening = isInitial ? (explicitOpening != null ? explicitOpening : openingSuggested)
                            : (ledger.opening_balance ?? null);
  const openingDate = isInitial ? (opening_date || (firstWithBal ? firstWithBal.date : null))
                                : (ledger.opening_date ?? null);

  // Only anchor the batch to the opening balance on the first import; on later
  // imports the anchor is far in the past, so we just check the batch internally.
  const check = balanceCheck(incoming, isInitial ? opening : null);

  const seen = new Set(ledger.transactions.map((t) => t._key || dedupKey(t)));
  const rules = (await readRules()).rules;   // learn-once rules applied on the way in

  const fresh = [];
  let skipped = 0, autoTagged = 0;
  for (const t of incoming) {
    if (seen.has(t._key)) { skipped++; continue; } // already imported, or dup within this file
    seen.add(t._key);
    const rec = {
      id: t.id,
      account: t.account,
      date: t.date,
      date_raw: t.date_raw,
      narrative: t.narrative,
      debit: t.debit,
      credit: t.credit,
      amount: t.amount,
      balance: t.balance,
      bank_category: t.bank_category,
      serial: t.serial,
      category: null,      // our own category (learn-once rule may fill it below)
      recurring: false,    // learn-once recurring flag
      invoice_id: null,    // reconciliation link — set when matched to an invoice
      _key: t._key,
      imported_at: nowIso(),
    };
    applyRulesToRow(rec, rules);
    if (rec.rule_applied) autoTagged++;
    fresh.push(rec);
  }

  const saved = !dryRun && fresh.length > 0;
  if (saved) {
    if (isInitial && opening != null) { ledger.opening_balance = opening; ledger.opening_date = openingDate; }
    ledger.transactions.push(...fresh);
    await writeLedger(ledger);
  }

  return {
    parsed: incoming.length,
    added: fresh.length,
    skipped,
    auto_tagged: autoTagged,
    total: ledger.transactions.length + (saved ? 0 : fresh.length),
    balanceCheck: check,
    dryRun: !!dryRun,
    saved,
    is_initial: isInitial,
    opening_suggested: openingSuggested,
    opening_applied: opening,
    opening_date: openingDate,
    preview: fresh.slice(0, 10).map((t) => ({
      date: t.date, narrative: t.narrative, amount: t.amount, balance: t.balance,
    })),
  };
}

// ── Categories ───────────────────────────────────────────────
async function listCategories() {
  const c = await readJsonOr(CATEGORIES_PATH, null);
  if (c && Array.isArray(c.categories)) return c.categories;
  await atomicWriteJson(CATEGORIES_PATH, { version: 1, categories: DEFAULT_CATEGORIES });
  return DEFAULT_CATEGORIES;
}
async function addCategory({ name, kind } = {}) {
  const nm = String(name || '').trim();
  if (!nm) { const e = new Error('category name required'); e.status = 400; throw e; }
  const k = (kind === 'in' || kind === 'out' || kind === 'both') ? kind : 'both';
  const cats = await listCategories();
  const id = slugify(nm);
  if (!cats.some((c) => c.id === id)) {
    cats.push({ id, name: nm, kind: k });
    await atomicWriteJson(CATEGORIES_PATH, { version: 1, categories: cats });
  }
  return cats;
}

// ── Learn-once rules ─────────────────────────────────────────
// A rule remembers, for a payee, the category and/or recurring flag the operator
// set once. Keyed on a "stem" of the Narrative: lowercased, whitespace-collapsed,
// with trailing reference/date tokens (pure digits, dates, card refs) stripped —
// so "AGL ENERGY 1234" and "AGL ENERGY 9987" share one rule. Deterministic and
// explainable; no fuzzy matching, no AI.
function narrativeStem(s) {
  const toks = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
  while (toks.length > 1 && /^[\d/\-#*.:]+$/.test(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}
async function readRules() {
  const r = await readJsonOr(RULES_PATH, null);
  return (r && Array.isArray(r.rules)) ? r : { version: 1, rules: [] };
}
async function listRules() { return (await readRules()).rules; }
async function writeRules(store) { await atomicWriteJson(RULES_PATH, store); }

async function upsertRule({ narrative, category, recurring } = {}) {
  const stem = narrativeStem(narrative);
  if (!stem) return null;
  const store = await readRules();
  let rule = store.rules.find((r) => r.match === stem);
  if (!rule) { rule = { match: stem, category: null, recurring: false, created_at: nowIso() }; store.rules.push(rule); }
  if (category !== undefined) rule.category = category || null;
  if (recurring !== undefined) rule.recurring = !!recurring;
  rule.updated_at = nowIso();
  // A rule with nothing to say is just noise — drop it.
  if (rule.category == null && !rule.recurring) store.rules = store.rules.filter((r) => r !== rule);
  await writeRules(store);
  return rule;
}
async function deleteRule(stem) {
  const store = await readRules();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.match !== stem);
  if (store.rules.length !== before) await writeRules(store);
  return store.rules.length !== before;
}
// Fill a row's category/recurring from the first matching rule (doesn't override
// values already set on the row). Records which rule fired, for transparency.
function applyRulesToRow(row, rules) {
  const stem = narrativeStem(row.narrative);
  const rule = rules.find((r) => r.match === stem);
  if (!rule) return row;
  if (rule.category != null && row.category == null) row.category = rule.category;
  if (rule.recurring && !row.recurring) row.recurring = true;
  row.rule_applied = rule.match;
  return row;
}

// ── Tag / reconcile a single transaction ─────────────────────
// patch: { category?, recurring?, invoice_id?, make_rule? }. Setting category or
// recurring also teaches a learn-once rule (unless make_rule === false), so the
// same payee is auto-tagged on future imports.
async function patchTransaction(id, patch = {}) {
  const ledger = await readLedger();
  const t = ledger.transactions.find((x) => x.id === id);
  if (!t) { const e = new Error('transaction not found'); e.status = 404; throw e; }
  let taught = false;
  if ('category' in patch) { t.category = patch.category || null; taught = true; }
  if ('recurring' in patch) { t.recurring = !!patch.recurring; taught = true; }
  if ('invoice_id' in patch) { t.invoice_id = patch.invoice_id || null; } // reconciliation link
  await writeLedger(ledger);
  if (taught && patch.make_rule !== false) {
    await upsertRule({ narrative: t.narrative, category: t.category, recurring: t.recurring });
  }
  return t;
}

module.exports = {
  FINANCE_DIR,
  LEDGER_PATH,
  CANONICAL_HEADER,
  init,
  listTransactions,
  getMeta,
  parseTransactions,
  balanceCheck,
  importCsv,
  listCategories,
  addCategory,
  listRules,
  upsertRule,
  deleteRule,
  narrativeStem,
  patchTransaction,
};
