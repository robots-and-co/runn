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

const CANONICAL_HEADER = 'Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial';

const nowIso = () => new Date().toISOString();
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

async function init() { await ensureDir(FINANCE_DIR); }

async function readLedger() {
  const l = await readJsonOr(LEDGER_PATH, null);
  if (l && Array.isArray(l.transactions)) return l;
  return { version: 1, transactions: [] };
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
function balanceCheck(rows) {
  const withBal = rows.filter((r) => r.balance != null);
  if (withBal.length < 2) {
    return { ok: true, checked: withBal.length, message: 'no running balance to verify' };
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
  return { ok: true, checked: withBal.length, message: `running balance matches across all ${withBal.length} rows` };
}

// Import (or preview) a CSV. body: { csv, account?, dryRun? }.
// Returns a summary; when dryRun is falsy and there are new rows, appends + saves.
async function importCsv({ csv, account, dryRun } = {}) {
  if (typeof csv !== 'string' || !csv.trim()) { const e = new Error('no CSV text provided'); e.status = 400; throw e; }
  const parsed = parseTransactions(csv, account);
  if (parsed.error) { const e = new Error(parsed.error); e.status = 400; throw e; }

  const incoming = parsed.rows;
  const check = balanceCheck(incoming);

  const ledger = await readLedger();
  const seen = new Set(ledger.transactions.map((t) => t._key || dedupKey(t)));

  const fresh = [];
  let skipped = 0;
  for (const t of incoming) {
    if (seen.has(t._key)) { skipped++; continue; } // already imported, or dup within this file
    seen.add(t._key);
    fresh.push({
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
      category: null,      // our own category — set in job 2
      recurring: false,    // learn-once recurring flag — set in job 2
      invoice_id: null,    // reconciliation link — set in job 2
      _key: t._key,
      imported_at: nowIso(),
    });
  }

  const saved = !dryRun && fresh.length > 0;
  if (saved) {
    ledger.transactions.push(...fresh);
    await writeLedger(ledger);
  }

  return {
    parsed: incoming.length,
    added: fresh.length,
    skipped,
    total: ledger.transactions.length + (saved ? 0 : fresh.length),
    balanceCheck: check,
    dryRun: !!dryRun,
    saved,
    preview: fresh.slice(0, 10).map((t) => ({
      date: t.date, narrative: t.narrative, amount: t.amount, balance: t.balance,
    })),
  };
}

module.exports = {
  FINANCE_DIR,
  LEDGER_PATH,
  CANONICAL_HEADER,
  init,
  listTransactions,
  parseTransactions,
  balanceCheck,
  importCsv,
};
