# Runn — handoff (billing-focused next pass)

Single-file frontend (`frontend/index.html`, ~5100 lines, vanilla JS, no
build step) + small Node backend (`worker/server.js`). Runs in Docker as
container `runn` on port 17777. `./frontend` is bind-mounted (edits go
live); `./worker` requires `docker restart runn` to pick up.

## Layout & state machine

```
+-----------+--------------------+----------------------+
|  Pane 1   |       Pane 2       |        Pane 3        |
| board +   |  open project +    | task | settings |    |
| header    |  task list + FAB   | billing (last-wins)  |
+-----------+--------------------+----------------------+
```

- `.panes` is a flex row on desktop; `display:block; width:300vw` on mobile
  with `transform: translateX(-Npx)` per `data-mobile-pane` attribute.
- `goPane(n)` sets the mobile attribute. `isMobileLayout()` (matchMedia
  wrapper) stays in lockstep with the `@media (max-width:700px)` rule —
  use it, not `window.innerWidth <= 700`.
- Pane 3 has a state machine `setPane3(mode, id)` with mode ∈
  `null | 'task' | 'settings' | 'billing'`. Each mode toggles one of:
  `#chatPanel`, `#chatSettingsPane`, `#billingPanel`. Three are siblings
  under `#pane3`; only one is `hidden=false` at a time.
- History: each pane transition `pushState({runnPane, mode, id})`. Single
  `popstate` listener reconciles pane state to the new top of stack.

## Two renderers

- **Pane 2 — `renderProjectPane(card)` + `renderProjectSteps()`**: simple
  project view; ids `projectTitle`, `projectClientSlot`, `projectBillBtn`,
  `projectSettingsBtn`, `projectSteps`, `projectFab`. Task list is FLAT
  (only direct children of `openProjectId`). Snap-to-gap drag-to-reorder
  via `computeStepDropSlot(clientY)` + `.chat-step.drop-before/after` CSS.
- **Pane 3 — `applyPanel(card)`**: handles the existing chat panel (task
  mode). When in settings mode we call `applyPanel(project)` to populate
  the settings form fields (chatCwd, chatPermMode, chatClient, chatTags,
  chatNotes) — `openCardId` is set to `openProjectId` for the duration
  so legacy handlers (chatCwd blur etc.) target the right card.

## Status / lifecycle

- Set: `queued | doing | review | done | blocked | hold`
- `hold` = "skip when queue gets here" (user-paused)
- `queued` was renamed from `todo`; `normStatus()` + legacy `chip-todo`
  alias handle any disk cards still saying `todo`. Server PATCH writes
  canonical values.
- `done_at`: server stamps on `* → done` transition, clears on leaving
  `done`, user-editable (frontend green pill in task header).
- Default new task status = `queued`.

## Billing model (READ THIS FOR THE NEXT SESSION)

Domain objects:
- **Client** (`~/runn-data/clients/cl_*.json`). Fields used by billing:
  `rate_per_hour` (per-client; null falls back to settings default),
  `gst_rate`, `currency`, `non_billable` (bool — track hours but exclude
  from outstanding totals + billing panel; used for the user's own org
  "RC"), `invoice_prefix`, `invoice_seq`.
- **Settings** (`~/runn-data/settings.json`). `default_rate_per_hour`
  (fallback when client has none), `currency_symbol`, `default_gst_rate`,
  `default_due_days`, `business_*`, `bank`. Cached client-side as
  `globalSettings`; reload via `reloadGlobalSettings()` after PUT.
- **Card hours / billing**: each task may have `hours` (number) and
  `billing ∈ {unbilled, invoiced, paid}` (cycle on chip click).
- **Invoice** (`~/runn-data/invoices/*.json`): `id`, `client_id`, `items[]`,
  `snapshot` (frozen from/to/bank/currency at issue time), `status`,
  `subtotal_ex_gst`, `gst`, `total_inc_gst`, `paid`, `balance`.

Key frontend functions (in `frontend/index.html`):
- `projectBillingRollup(projectId)` → `{ total, unbilled, invoiced, paid,
  doneUnbilled }` hours.
- `projectOutstandingDollars(projectId)` → `{ amount, symbol }` or `null`.
  Uses `doneUnbilled × rate`. Returns `null` for personal projects (no
  client) AND non-billable clients.
- `globalOutstandingDollars()` → sum across all projects. Drives the pane 1
  `$X.XX` chip via `refreshOutstanding()`.
- `billingGroups()` — groups done+(unbilled|invoiced) cards by client.
  Honours `billingScopeProjectId` (pane 2 bill button → that project's
  subtree only) AND skips non-billable clients.
- `openComposer(clientId)` — invoice composer modal. Pulls client's
  done+unbilled cards, prefills line items with `date = c.done_at ||
  c.updated_at`, rate × hours.
- Invoice route: `/invoices/:id` (history-based SPA). `renderInvoicePage(id)`
  renders A4 layout in `#invoicePage`.

Backend endpoints:
- `GET/PUT /settings` — global settings (spread-merge body).
- `GET/POST/PATCH/DELETE /clients[/:id]`.
- `POST /invoices` — issues; bumps client.invoice_seq, mints id from
  `{prefix}{seq}`, snapshots from/to/bank/currency.
- `GET /invoices`, `GET /invoices/:id`, `PATCH /invoices/:id` (status, paid).

## Where billing UX is weak right now (probable next-session targets)

- **No partial-invoice flow**: composer pulls every unbilled card; user
  can edit/remove rows but can't filter by date range or by project.
- **No batch billing-state ops**: marking N cards "invoiced" requires
  going one-by-one in the billing panel (there is a "mark all invoiced"
  per-group, but no broader UX).
- **Invoice list (Invoices tab) is read-only** — no search, no filter,
  no payment-recording form (only the per-invoice mark-paid button).
- **No reminders / aging report**: invoices don't surface "X days overdue".
- **No PDF export** outside the browser print path. `window.print()` works
  for the A4 layout but is fiddly.
- **`apsDefaultRate` exists** in app-settings modal; per-client rate still
  takes precedence. Currency symbol is global, not per-client (the
  client.currency field exists in the schema but isn't used end-to-end).
- **non_billable clients** don't render in the billing panel groups at all
  — fine for outstanding $ but means you can't see their hours summary
  per-client anywhere except the project card.
- **done_at recently added**; invoice line item dates use it. Composer
  hasn't been updated to let user override per-line date easily (the
  field is editable but discoverability is low).

## Key file paths

- `frontend/index.html` — entire frontend (style + HTML + script).
- `worker/server.js` — all HTTP routes incl. /settings, /clients, /invoices.
- `worker/queue.js` — AI queue walker; respects `hold` (skip), `done` (skip),
  `blocking` flag.
- `worker/bridge.js` — Claude subprocess spawning; concatenates
  `title + "\n\n" + notes_md` as the first prompt (this is how multi-turn
  human chat reaches Claude).
- `~/runn-data/cards/` — card JSON. Archived ones move to `cards/archive/`.
- `~/runn-data/clients/` — client JSON.
- `~/runn-data/invoices/` — invoice JSON.
- `~/runn-data/settings.json` — global settings.
- `~/runn-data/CLAUDE.md` — schema docs.

## Conventions worth knowing

- **No build step**. Vanilla JS. One file. Reactive via direct DOM mutation
  + WebSocket events (`card.added/changed/removed`, `session.updated`,
  `client.*`, `permission.*`).
- **Status renames are read-time tolerant**: `normStatus()` in the frontend
  and the inline `=== 'todo' ? 'queued' :` pattern in queue.js handle
  legacy on-disk values.
- **Hidden via `[hidden]` attribute**, not CSS classes. Several rules
  needed explicit `.x[hidden] { display: none }` because a default
  `display: flex` on the class otherwise wins (see `.chat-body[hidden]`
  and the removed `.chat-panel.is-task .chat-fab` rule).
- **Mobile**: `body { position: fixed }` + viewport meta with
  `user-scalable=no` locks zoom; `html { touch-action: pan-y }` kills
  accidental horizontal swipe between panes. Form inputs forced to 16px
  on mobile to prevent iOS auto-zoom.

## Running

```bash
docker ps                       # 'runn' on 17777
curl http://127.0.0.1:17777/    # 200 OK
docker restart runn             # after server.js / queue.js changes
```

Frontend edits go live without restart. Use the Playwright test pattern
already in `/tmp/test-*.py` files for smoke tests:

```py
browser = await p.chromium.launch(
  executable_path='/home/waz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
  headless=True)
```

---

# 🛠 RUNBOOK — "ANCHOR CUTOVER"  (host-only, container-down)

> **Recall:** to execute this, tell the host Claude:
> *"Execute the ANCHOR CUTOVER runbook in HANDOFF.md."*
>
> **Run this from the HOST, never from inside the `runn` container** — every
> step stops/recreates `runn` or rewrites the card files it watches. A session
> running *inside* Runn would kill itself mid-step. The host has its own
> `claude` CLI and `docker`; use that.

**Why this exists.** Three changes were prepared but deliberately deferred to a
single maintenance window because each needs the engine **down** (it can't
safely rewrite itself while running): deploy pending `worker/` code, normalise
the card paths, and move Claude's state into a named volume so the whole stack
is portable. Do them in order. Take backups first.

## Pre-flight (always)
```bash
docker ps | grep runn                      # confirm container name = runn, :17777
cd /home/waz/projects/runn && git status    # worker/ edits land here (== /app/worker)
cp -a /home/waz/runn-data/cards /home/waz/runn-data/cards.bak.$(date +%Y%m%d)
tar czf /home/waz/claude-state.bak.$(date +%Y%m%d).tgz -C /home/waz .claude .claude.json
```

## Step 1 — Deploy the reviewed `worker/` code (Track B)
`frontend/` is live-mounted (no restart). `worker/` changes only take effect on
restart. After the Track B cards have landed in `review` and you've eyeballed
the diff:
```bash
docker restart runn
docker logs --tail=50 runn          # confirm clean boot, no stack traces
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17777/   # expect 200
```

## Step 2 — Normalise card paths (migration)
Goal: stop baking absolute paths into cards. Write `worker/migrate-paths.js`
following the existing `worker/migrate-clients.js` / `migrate-projects.js`
pattern. It should, over every `runn-data/cards/*.json`:
- repoint client work off `/home/waz/runn-data` onto its client workspace
  (`/home/waz/projects/{lthcs,ngs,rc,zis}`) per the card's `client_id`;
- fix the stray `/home/waz/runn-data/lthcs/` cwd (→ `/home/waz/projects/lthcs`);
- store `location.cwd` **relative to `$HOME`** and drop the stored absolute
  `session_path` (the worker can derive it at read-time via `sessionPathFor`).
**Run it while `runn` is stopped** so the chokidar watcher isn't firing on 119
rewrites and the queue isn't acting on half-changed cwds:
```bash
docker stop runn
docker run --rm -u 1000:1000 -e HOME=/home/waz \
  -v /home/waz:/home/waz runn:local node /app/worker/migrate-paths.js --dry-run
# review output, then drop --dry-run to apply
docker start runn
```
(`cards.bak.*` from pre-flight is the rollback.)

## Step 3 — Containerise Claude's state (`~/.claude` → named volume)
Makes the stack portable: login + history + config travel with a Docker volume
instead of the host home. In `docker-compose.yml`, the `~/.claude` bind mount is
**line 28** (`- ${RUNN_HOME}/.claude:${RUNN_HOME}/.claude`).

1. Create the volume and seed it from the current host dir so **login + history
   survive** (the OAuth token in `~/.claude/.credentials.json` refreshes and is
   written back, so it must live somewhere persistent + writable — a volume is
   ideal; never bake it into the image):
   ```bash
   docker volume create runn-claude-state
   docker run --rm -v runn-claude-state:/dst -v /home/waz/.claude:/src:ro \
     alpine sh -c 'cp -a /src/. /dst/'
   ```
2. Replace line 28 with the named volume:
   ```yaml
       - runn-claude-state:${RUNN_HOME:-/home/waz}/.claude
   ```
   and add at the bottom of the file:
   ```yaml
   volumes:
     runn-claude-state:
       external: true
   ```
3. Recreate and verify Claude still authenticates:
   ```bash
   docker compose up -d --force-recreate runn
   docker exec -u 1000:1000 runn claude -p --print 'say OK' | tail -1
   ```

⚠ **Trade-off to accept before doing Step 3:** today the container and the
host's bare `claude` CLI **share** the same `~/.claude` (and the compose comment
at lines 11–15 relies on `HOME` matching so the project slug is identical). A
named volume **isolates** the container's Claude state from the host — sessions
started by the host CLI won't appear inside Runn and vice-versa, and you reach
the volume's files via `docker cp` / a temporary mount rather than your host
shell. If you actively use the host `claude` against these same projects, keep
the bind mount and skip Step 3 (portability via convention only).

## Post-cutover
- `docker logs --tail=100 runn` clean; board loads at :17777; open one migrated
  client card and confirm its chat/cwd resolves and a spawn works.
- Update the [[zis-network-smb-wg]] / per-client `projects/*/CLAUDE.md` if the
  migration surfaced any path or host corrections.

---

# 🧩 TRACK B CARD — "WORKSPACE PICKER" (app code; deploys at ANCHOR CUTOVER step 1)

App-code change, so it lands as a child card under the **Runn Builder** project,
gets reviewed, and goes live on the next `docker restart runn` (frontend edits
are live; `worker/` needs the restart). Pairs with the path-normalisation in
ANCHOR CUTOVER step 2 — store the chosen cwd **relative to `$HOME`**.

**Goal.** Stop free-typing a cwd in project/task settings. The directory becomes
a pick from a known set, defaulted from the client, and every client gets a
workspace folder provisioned automatically.

**Why not "client → one folder".** One client ≠ one directory. RC alone already
has 7 workspaces (`easy-fleet-endpoint-manager`, `easy-fleet-it-manager`, `hub`,
`coach`, `business-brains-ui`, `SSD`, `runn`). A fixed client→dir map would
collapse them. So: client sets the **default**, project can **override** to any
dir under `~/projects/`.

## Backend (`worker/server.js`)
- **`GET /workspaces`** → list immediate subdirectories of `$HOME/projects`
  (dirs only; skip dotfiles + `node_modules`). Feeds the dropdown.
- **`POST /clients`** (after writing the client JSON): derive a slug from the
  client name (lowercase-kebab; fall back to client id), `mkdir -p
  $HOME/projects/<slug>`, and if no `CLAUDE.md` exists there, seed a stub
  (`# <name> — workspace stub` + a line noting it inherits `../CLAUDE.md`).
  **Idempotent** — safe to re-run; never overwrite an existing CLAUDE.md.
- Store the client's default workspace explicitly on the client JSON
  (`workspace: "<slug>"`) rather than re-deriving from the name each time — so
  RC's default can differ from its name and be edited.

## Frontend (`frontend/index.html`)
- Replace the **`chatCwd`** free-text input (settings/task panel) with a
  `<select>` populated from `GET /workspaces`. Remove the free-typing path.
  (Optional escape hatch: a single "＋ new workspace…" option that POSTs a
  mkdir — only if you want it; not required.)
- When **`chatClient`** changes, default the cwd select to that client's
  `workspace` dir (or `projects/<client-slug>`). User can still override to any
  listed dir for multi-product clients.
- On change, PATCH the card's `location.cwd` (relative to `$HOME` per step 2).

## Safety / constraints
- Choices are constrained to **under `$HOME/projects`** — never arbitrary host
  paths. This is also the first structural step toward per-client access
  scoping (the "blast radius" concern): a card can only be anchored inside the
  projects tree.
- Keep the bridge's ENOENT guard — a cwd whose dir is missing must fail the
  spawn cleanly, not wedge the queue.

## Edge cases
- **Personal** project (no client): default the picker to `runn-data` (or a
  `personal/` dir); let the user choose.
- **Legacy cards** with absolute/free-form cwd: tolerate on read; ANCHOR CUTOVER
  step 2 normalises them.

