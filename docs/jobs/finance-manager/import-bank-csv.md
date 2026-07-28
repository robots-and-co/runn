---
order: 1
status: todo
title: Import — bank CSV in, duplicate-proof
---

# Import — bank CSV in, duplicate-proof

## Why
The finance manager mixes two sources of truth: invoices Runn already holds, and
a bank CSV the operator exports from their account. This job brings the bank side
in. It is also where the new **Finances** area of the app is first stood up.

**Hard constraint, applies to this whole thread:** no financial number ever
leaves the machine. No cloud service, no AI/LLM (local or remote), no external
API. Everything here is plain deterministic code running locally against
`~/runn-data`. This is a deliberate market position, not a nice-to-have — treat
"a number went to a cloud/AI service" as a defect.

## Goal
Drop in a bank CSV, get clean, categorizable transactions stored locally, with
re-imports of the same file creating **zero** duplicates and a built-in check
that nothing was dropped.

## The CSV format (known, fixed)
Header, exactly:

```
Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
```

Column mapping:

| Column        | Use                                                                 |
|---------------|---------------------------------------------------------------------|
| Bank Account  | stored, hidden in display (single account today; kept for future)   |
| Date          | transaction date                                                    |
| Narrative     | description / payee — the key field for matching and categorizing   |
| Debit Amount  | money **out** (an expense)                                          |
| Credit Amount | money **in** (a deposit — matched against invoices in job 2)        |
| Balance       | stored — running balance, used for the integrity check below        |
| Categories    | stored, hidden — the bank's own category; we ignore it and do ours  |
| Serial        | stored, hidden — the bank's row id; used for de-duplication         |

A row is money-in or money-out depending on which of Debit/Credit is populated.

## Approach
- **New app area.** Add a `finance` mode + panel alongside the existing modes
  (`task | settings | billing | invoice`) in the three-pane SPA — same shape as
  the invoice page was added. See HANDOFF.md for the mode/panel switch. The
  import screen is the first screen inside it.
- **Storage.** New local store, e.g. `~/runn-data/transactions/*.json` (one file
  per transaction, or a per-import batch file — match whatever pattern is
  simplest given how invoices/cards are stored). Nothing goes anywhere else.
- **Parse & load.** Server-side CSV parse (Node only in spawned envs — no
  python3/jq). Store all eight columns; display only Date, Narrative, amount,
  and our own category (added in job 2).
- **De-dupe on Serial.** On import, skip any row whose `Serial` (scoped to Bank
  Account) already exists. Re-importing last month's file plus this month's must
  only add the genuinely new rows. Report "added N, skipped M duplicates".
- **Balance integrity check.** After import, walk the rows in date order and
  confirm our running total matches the bank's `Balance` column on each row. If
  it diverges, surface it plainly ("import may be missing rows between X and Y")
  rather than silently accepting it.
- **Import screen UX.** Choose file → preview first few mapped rows → confirm →
  result summary (added / skipped / balance check ok or warning). Mirror the
  calm, single-purpose feel of the invoice screens.

## Out of scope (later jobs)
- Matching credits to invoices and categorizing → job 2.
- Any overview or forecast → jobs 3 and 4.
