# Restructure runn into a 3-pane layout

You are picking up the runn task tool to convert it from its current
single-drawer layout into a three-pane app. Read the codebase before touching
anything: it's small enough that you can hold the relevant parts in head.

## Read first

- `frontend/index.html` — the entire frontend. Vanilla HTML/CSS/JS, ~5000
  lines, single file. No framework, no build step.
- `worker/server.js` — Node backend. Routes only matter for context; you
  shouldn't need to change it.
- `docker-compose.yml` — the app runs in Docker (`docker ps` shows the
  `runn` container on port 17777). `./frontend` is bind-mounted, so frontend
  edits go live immediately. `./worker` is too, but server.js requires
  `docker restart runn` to pick up.
- `~/runn-data/CLAUDE.md` — card data schema.

Cards live at `~/runn-data/cards/*.json`. Projects are cards with `parent_id:
null`; tasks have a parent. Don't reshape the data model.

## What it looks like today

- The main board (`#items`) lists all projects as big cards. Clicking a
  project opens `#chatPanel`, a right-side drawer that slides in over the
  board with a dimmed backdrop.
- `#chatPanel` is reused for BOTH projects and tasks. `applyPanel(card)`
  reparents elements and toggles `.is-project` / `.is-task` classes to swap
  modes.
- Project settings are a "second face" of `#chatPanel` — `setSettingsView(true)`
  adds a `.settings-view` class that hides the body and shows `#chatSettings`.
- Billing is a separate fullscreen overlay (`#billingPanel`) with its own
  open/close functions (`openBilling()`, `closeBilling()`).
- Navigation history: the panel pushes one history entry when it opens
  (`history.pushState({ runnSidebar: true }, '')`); a `popstate` listener
  closes the panel on back.
- Mobile breakpoint at `@media (max-width: 700px)` makes the chat panel
  full-width.

## Target: three panes

```
desktop (>700px wide):
+-----------+---------------------+---------------------+
|  Pane 1   |       Pane 2        |       Pane 3        |
|  ~400px   |       flex: 1       |       flex: 1       |
|           |                     |                     |
| projects  |  selected project   |  task | settings    |
|  list     |   (task list +      |       | billing     |
| (current  |    project chat)    |       | (empty when |
|  cards)   |                     |        nothing sel) |
+-----------+---------------------+---------------------+

mobile (≤700px):
one pane visible at a time, full-screen. Tapping into a deeper pane slides
the next one over. Back button (browser + Android) pops one pane.
```

### Pane 1 — projects list (persistent)

- Same big-card style as the current board. Keep tags, hours rollup, client
  chip, due badges, sort/archive toggles, footer "what else do you need to
  do?" input — all of it. Don't reduce density.
- Pane 1 stays visible on desktop at all times. The "active" project gets
  the existing `.card.active` highlight.

### Pane 2 — selected project (middle pane)

- Empty state when no project is selected. Empty state is fine to be
  minimal: a single-line hint like "Select a project on the left."
- When a project is selected, pane 2 holds what the project face of
  `#chatPanel` shows today, MINUS settings and MINUS billing. That means:
  - Project title (header), client chip, billing total button, settings
    cog (but settings opens in pane 3, not in this pane)
  - The task list (currently rendered via `renderSteps()` into `#chatSteps`)
  - The "+ Add task" FAB
  - The project-level chat input (currently `#chatInput` etc. — projects
    don't have AI sessions so this is mostly the description / notes UI)
- The status chip dropdown in the header should keep behaving the same.
  The Delete option in that dropdown still archives + navigates back (but
  now "back" means clearing pane 2 / 3 instead of closing a drawer).

### Pane 3 — task / settings / billing (mutually exclusive, last-wins)

- Pane 3 shows exactly one of these at a time:
  - **Task detail** — what `#chatPanel` shows today for a task (status chip
    dropdown, first-turn bubble OR chat transcript, etc.).
  - **Project settings** — what `#chatSettings` shows today.
  - **Billing panel** — what `#billingPanel` shows today.
- Opening any of these replaces whatever was there. Closing pane 3 (back
  arrow / Escape) clears it; pane 2 stays visible.
- Empty when nothing is selected.

## Mobile breakpoint

- Below ~700px, one pane at a time fills the viewport.
- Navigation is a left-to-right stack: pane 1 → 2 → 3. Each "navigation
  forward" pushes a history entry. Browser back / Android back pops one
  step.
- The header back arrow should match: pane 3 → pane 2 → pane 1 → (close
  app / no-op). This must be consistent with what the OS back button does.

## History / back-button model

The current code already uses `history.pushState({ runnSidebar: true }, '')`.
Generalize this so each navigation transition pushes a labelled state, e.g.

```js
history.pushState({ runnPane: 2, projectId }, '');     // open project
history.pushState({ runnPane: 3, mode: 'task',     id }, '');
history.pushState({ runnPane: 3, mode: 'settings', projectId }, '');
history.pushState({ runnPane: 3, mode: 'billing'              }, '');
```

A single `popstate` listener reconciles state ← URL/state object. Pressing
back goes one entry down the stack; on mobile this also visually slides
back. On desktop, "back" is mostly a no-op because all panes are visible —
but settings/billing/task in pane 3 should still close on back.

Pick whichever exact encoding works cleanest, but the contract is: the
browser/OS back button always corresponds to "step back one pane / mode."

## Constraints

- No framework. Stay vanilla. The whole frontend is one HTML file and it
  should stay that way.
- Don't change the backend, the data model, or the WS message types.
- Keep all existing features working: the chip-menu dropdown (with Delete),
  the first-turn bubble (editable while human, locked once `assignee=ai`),
  the client chip in the header, the billing modal flow, AI session
  spawning + transcript polling, due-date badges, tag chips, drag-to-reorder
  tasks, archive/unarchive, the FAB. None of these should regress.
- Use `chatChipWrap` / `chatChip` / `chatChipMenu` from the existing code
  (status dropdown — recently added; menu is right-anchored).
- The Description section is currently hidden on tasks via CSS; keep that
  behavior (the first-turn bubble IS the task content).
- Tasks default to `assignee: 'human'` with an empty title; the "+ Add task"
  FAB creates with `title: ''` and the panel auto-focuses the first-turn
  input. Preserve this UX.

## Suggested staging

You can do this in one shot if you want, but if you stage it:

1. **Layout shell.** Wrap the existing board + `#chatPanel` in a
   three-column grid. Move the board into pane 1. Pane 2 and pane 3 are
   empty containers for now. Verify nothing visually broken on desktop.
2. **Project view into pane 2.** When a project is selected, render its
   view into pane 2 (instead of the right-side drawer). Settings + billing
   triggers still go to the old overlays for now.
3. **Pane 3 hosts task / settings / billing.** Build a tiny state machine
   `{ mode: null | 'task' | 'settings' | 'billing', id }`. Route the three
   sources of pane-3 content into one container; tear down the old drawer
   / overlay positioning.
4. **Mobile breakpoint.** Below 700px, switch to one-at-a-time. Slide
   transitions between panes; pane chrome (back arrows) hidden on desktop,
   shown on mobile.
5. **History/back-button.** Wire `pushState` per transition and `popstate`
   for back. Test browser back, Android back (DevTools mobile mode is a
   reasonable proxy), Escape key.
6. **Smoke test with Playwright.** Drive the app end-to-end: open project,
   open task, open settings, open billing, click delete from the chip
   dropdown, back-button through each pane on mobile viewport. The previous
   work in this repo used `playwright.sync_api` Python scripts at
   `/tmp/runn-*.py`; same pattern works here.

## Running it

```bash
docker ps               # confirm 'runn' container is up on port 17777
curl http://127.0.0.1:17777/   # 200 OK
```

Frontend edits go live without restart. Server edits need `docker restart
runn`. Headless Chromium for smoke tests is at
`~/.cache/ms-playwright/chromium-1217`; Python playwright is installed.

## Acceptance

- All three panes visible and functional on desktop ≥1100px.
- Mobile (DevTools 375×667 or actual phone): one pane at a time, slide
  transitions, OS/browser back button steps back through pane history.
- Every feature listed under Constraints still works.
- A screenshot suite saved under `/tmp/runn-screens/` covering: pane 1
  alone, pane 1+2, pane 1+2+3 (task), pane 1+2+3 (settings), pane 1+2+3
  (billing), and the mobile equivalents.
- Smoke test reports zero console errors / pageerrors.

When done, summarise the structural changes (which `applyPanel`-style
functions split into pane-2 vs pane-3 renderers, the new state machine for
pane 3, and the history model) so a follow-up reader can pick it up.
