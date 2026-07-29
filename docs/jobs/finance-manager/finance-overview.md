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
