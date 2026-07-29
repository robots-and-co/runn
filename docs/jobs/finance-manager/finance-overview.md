---
order: 3
status: doing
title: Overview — cash, income vs costs, who owes
---

# Overview — cash, income vs costs, who owes

## Why
With the reconciled, categorized ledger in place (job 2), the operator wants a
single screen answering "where do I stand right now" — without opening a
spreadsheet and without any number leaving the machine.

Same hard constraint: all figures computed locally, no cloud, no AI.

## Goal
A calm dashboard of the present: cash on hand, money in vs money out over recent
months, and who still owes money — every figure clickable back to the rows behind
it.

## Approach
- **Cash on hand.** The latest bank `Balance` (from the most recent imported row),
  shown plainly with its as-of date.
- **In vs out by month.** Group reconciled transactions by month and by our
  categories; show money-in vs money-out per month (simple bar/column chart +
  a table). Reuse the same self-contained inline-chart approach the app already
  uses; no external chart CDN (sandbox has no network).
- **Who owes you.** Outstanding = issued-but-unpaid invoices. This comes free
  from data Runn already holds (`~/runn-data/invoices`, billing rollups); surface
  it here rather than duplicating the billing logic — call the existing
  rollup/billing helpers.
- **Drill-down.** Every headline number links to the underlying rows (a month's
  transactions, the unpaid-invoice list), so the operator can always see what a
  figure is made of.
- **No projection here.** This screen is strictly "today and the recent past".
  Forward-looking numbers live in job 4.

## Depends on
- Job 2 (needs reconciled, categorized transactions).
- Existing billing/invoice rollups for the "who owes you" figure.

## Decisions
2026-07-29 (built) — Overview tab is live (read-only, all arithmetic). Four
headline cards: cash on hand (= calculated balance), money in, money out (+ net),
owed to you. Then: money in vs out by month (inline CSS bars, most recent 12,
green in / red out + net), "where the money went" (money-out by category with
bars; uncategorized shown), and "who owes you" (unpaid invoices only — status ≠
paid — sorted by due date, overdue flagged, each row clicks through to the
invoice). **No double-count** falls out naturally: cash flow comes from the bank
transactions (a reconciled deposit is one row), and "owed" lists only unpaid
invoices — so a paid+reconciled invoice drops out of "owed" and isn't re-added as
income. An "N still uncategorized" nudge points at the Money in & out tab.

2026-07-29 — Added a fifth headline card, **Not yet billed** (= sum of the
Billing tab's rollup: done, non-archived jobs on billable clients with a rate,
not yet invoiced). Sits before "Owed to you" in the money-coming pipeline (done
→ not yet billed → invoiced/owed → paid/cash). No double-count: invoicing a job
flips its status to `invoiced`, so it leaves this pool the moment it enters
"owed". Headline number only — no per-client breakdown.

2026-07-29 — Added a **Total position** headline above the cards: cash on hand +
not yet billed + unpaid invoices. Rationale: money owed is a timing matter, not a
separate balance — so the operator's real standing is one figure, not a mental
sum of "cash" and "owed". The individual cards remain as the breakdown.

2026-07-29 — Replaced the by-month cash chart with a **bottom-line summary**:
three bars — money in, money owed, money out — and a **Total** beneath = the
operator's worth (cash on hand + money owed). The bars are the story (flows); the
total is the position, so it reads cash + owed rather than in − out (money in/out
already sit inside cash on hand). A sub-line spells out the total's makeup. The
per-month breakdown was dropped (can return if wanted).

2026-07-30 — **Finances restructured around the Overview.** Left list is now
Overview (default landing) + generated BAS reports (each financial year's four
quarters + full year). The Overview merges the dashboard + forecast on top, with
three sub-tabs beneath: **Transactions** (import + reconcile — the old "Money in
& out", renamed), **Subscriptions** (regular outgoings, from the "repeats
monthly" flag), and **Contracts** (expected income). Import is no longer its own
tab; it sits at the top of Transactions. BAS reports are cash-basis GST with the
agreed default (GST on everything except bank fees & wages), and surface GST-free
and unsorted amounts as caveats. A per-category GST toggle can refine the default
later. Frontend-only change.
