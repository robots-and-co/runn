---
order: 2
status: todo
title: Money in & out — match to invoices, categorize
---

# Money in & out — match to invoices, categorize

## Why
Once bank rows are imported (job 1), the central risk of mixing two sources is
**double-counting**: a paid invoice appears once as a Runn invoice and again as
the bank deposit that paid it. This screen is the single source of truth that
resolves that — it reconciles the two sides and sorts every row into a category.
Everything downstream (overview, forecast) reads from here.

Same hard constraint as the whole thread: entirely local, no cloud, no AI.

## Goal
One honest list of money in and out, where each paid invoice is counted **once**,
new bank rows are categorized, and categorizing/flagging a payee **once** makes
future imports do it automatically.

## Approach

### Match bank credits to invoices (no double-count)
- For each money-in (Credit) bank row, **auto-suggest** the invoice it likely
  paid, by amount + date proximity (and any client hint in the Narrative).
- Operator confirms a suggestion with one tap. A confirmed match links the bank
  row to the invoice and counts as **one** payment, not two.
- Unmatched credits remain as their own income lines (money in Runn never issued
  an invoice for).
- An unpaid invoice with no matching deposit stays "still owed" — it feeds the
  forecast as expected income (job 4), and already shows in billing today.

### Categorize
- Every row gets one of our own categories (money-out: e.g. utilities, software,
  supplies; money-in: e.g. client income, other). The bank's own `Categories`
  column is ignored.
- Categories are a small local list the operator can extend. No fixed taxonomy
  imposed.

### Learn-once rules (the mechanism the operator asked for)
- Tagging a row's **category** and/or marking it **recurring monthly** creates a
  rule keyed on the Narrative (payee). Store rules locally, e.g.
  `~/runn-data/finance/rules.json`.
- On every future import, apply matching rules automatically: a known payee's
  rows arrive already categorized and already flagged recurring. Tag "AGL" as
  Utilities + recurring once → every future AGL row inherits both.
- Matching is deterministic text matching on Narrative (exact, then
  normalized/startswith) — **no AI, no fuzzy model.** Keep it explainable so the
  operator can see why a row was auto-tagged, and override any single row without
  breaking the rule.

## Depends on
- Job 1 (transactions must exist to reconcile and tag).

## Out of scope
- Charts / cash position → job 3. Projection → job 4.
