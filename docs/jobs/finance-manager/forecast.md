---
order: 4
status: doing
title: Forecast — project the next few months
---

# Forecast — project the next few months

## Why
The reason the finance manager exists: look forward, not just back. Given known
recurring costs and expected invoice income, project where cash lands over the
next few months — so the operator can see a squeeze before it arrives.

Same hard constraint, and it matters most here: **the forecast is arithmetic, not
AI.** No local model, no cloud model, no LLM anywhere. It is a deterministic
calculation over local data. Any plain-English summary is a **templated
sentence** (fill-in-the-blanks), never generated text.

## Goal
A chart + table projecting cash forward N months, built only from data already on
the machine, that the operator can trust because they can see exactly what went
into it.

## Approach
- **Inputs, all local:**
  - Starting cash = latest bank balance (from job 1/3).
  - Recurring costs = transactions flagged recurring in job 2, projected forward
    at their observed amount/cadence (monthly to start).
  - Expected income = outstanding unpaid invoices (due dates feed the month they
    land in), plus optionally an assumed run-rate the operator can toggle/edit.
- **The calculation:** month by month, `end = start + expected_in − expected_out`,
  carrying the balance forward. Pure code; show the working.
- **Display:** a projected-balance line/column chart + a month-by-month table
  (opening, expected in, expected out, closing). Same inline no-network chart
  approach as job 3.
- **Templated summary (no AI):** one line like
  `"At this rate, cash is about $X by <month>."` — string interpolation over the
  computed numbers. If it can't be filled from real numbers, show nothing.
- **Assumptions visible & editable:** let the operator adjust the horizon (e.g.
  3/6/12 months) and the recurring set; recompute instantly. No hidden fudge
  factors.

## Depends on
- Job 2 (recurring flags) and job 3 (cash-on-hand + outstanding invoices).

## Decisions
2026-07-28 — Dropped the local-LLM "explainer" entirely (operator: no numbers
through any cloud or AI service). Forecast is deterministic arithmetic; any prose
is a templated sentence, not model output. This replaces the earlier
"local model narrates the numbers" idea from the finances memory note.

2026-07-29 (built) — Forecast tab is live. Inputs: cash on hand, transactions
flagged "repeats monthly" (deduped per payee, most recent amount = the monthly
figure), and unpaid invoices bucketed by due month (overdue → month 1, past the
horizon → left out and counted). Projects from next month, carrying
`closing = opening + expected_in − expected_out`. Horizon selector (3/6/12 mo)
recomputes instantly. Shows: templated one-liner ("At this rate, cash is about
$X by <month>") plus a below-zero warning, a "show the working" basis line, a
per-month projected-balance bar (red when negative), and the full opening/in/out/
closing table. No model of any kind — pure arithmetic.
