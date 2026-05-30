# Runn 2.0 — fresh build on the NUC

A clean-room rebuild of Runn from a refinement conversation that radically
simplified the data model. Hardware moves from the current big box to a
Gen 12 i5 NUC with 64GB / Gen4 NVMe.

This doc briefs the host's Claude Code desktop session: model + migration +
build sequence. Self-contained — does not require reading the old codebase.

---

## 1. The new model (locked)

**One object: the stream.** A stream is a chat is the atomic billable unit.
No separate "task" or "project" layer.

- **Stream** = a chat with AI. Has turns, hours, status, client, optional
  cosmetic project tag. Billable on its own.
- **Client** = who it's for. Carries billing identity (rate, currency, GST,
  invoice prefix, workspace slug). One client = one cwd (per Claude Code
  conventions — the cwd is what Claude Code calls a "project").
- **Project** = a cosmetic billing grouping of streams. AI suggests groupings
  at invoice time; user can override. Streams stay individually billable but
  group together on the invoice layout for neatness.
- **Invoice** = one line item per stream, grouped under project headings.

What goes away from the old Runn:
- The "+ Project" button. There are no projects to create directly.
- The task layer. No subtasks under projects.
- Pane 2 navigation through projects.

What stays:
- Per-client billing identity (`rate_per_hour`, `currency`, `gst_rate`, etc.).
- The invoice format (described as "near perfect" in refinement).
- Hours tracking on the unit of work (now the stream, not the task).
- Per-cwd lock (one client's workspace = one Claude writer at a time).
- The MCP permission gate.
- Plan-then-apply approval flow.

---

## 2. UX shape

**Two panes** (was three):
- **Left**: chat input at the top, always focused. List of streams below,
  search-filtered (heuristic fuzzy text on title + body + client name, ranked
  by recency).
- **Right**: the open stream's chat (turn-by-turn bubbles), or the
  billing/invoice view when you're in those.

**Stream metadata** (client chip, status, hours, due) lives in the chat's
header — not in a sidebar.

**Entry flow** (the "fix server A" emergency case):
1. Open Runn → cursor is already in the chat input.
2. Type the question and send.
3. AI reads the first turn and proposes a client ("looks like ZIS — confirm?").
4. User accepts or picks a different client with one tap.
5. Stream is now classified and recorded.

**No upfront ceremony.** No client picker before typing, no project picker
ever, no template, no required title (AI can name the stream from the first
turn too).

---

## 3. Data model

```
streams/<id>.json
  id, client_id, title (AI-named, user-editable),
  status: open | doing | review | done | invoice | invoiced | paid | blocked | hold,
  created_at, updated_at, done_at,
  hours (number),
  turns: [{ role: 'user' | 'ai', text, at, session_event?, ... }],
  session_id?  (Claude Code session, for --resume),
  billing_project_id? (the cosmetic grouping),
  invoice_id?, invoice_line_id?,
  archived: bool

clients/<id>.json
  Carry forward verbatim from old Runn — schema is fine.
  id, name, workspace (slug under ~/projects/), rate_per_hour, currency,
  gst_rate, non_billable, invoice_prefix, invoice_seq, notes_md.

billing_projects/<id>.json
  id, name, client_id, created_at, ai_suggested: bool, archived: bool.
  Pure presentation — no logic depends on this object.

invoices/<id>.json
  Carry forward; items[].stream_id replaces items[].card_id.
  Otherwise identical: snapshot, subtotal_ex_gst, gst, total_inc_gst, paid, etc.

settings.json
  Carry forward verbatim — business info, defaults.
```

---

## 4. What carries forward from the old machine

```
~/runn-data/clients/         → import as-is
~/runn-data/invoices/        → import as-is (historical reference)
~/runn-data/settings.json    → import as-is
~/projects/<slug>/           → rsync (already pushed to GitHub, but copy local
                                 to preserve uncommitted state if any)
~/.claude/                   → rsync (sessions, history, memory all carry)
~/.ssh/                      → rsync (keys; known_hosts will rebuild on first use)
/etc/wireguard/              → copy configs as root; re-bring-up tunnels
```

## 5. What gets archived but NOT imported

```
~/runn-data/cards/           → tar+gzip into /home/waz/runn-archive/cards-YYYYMMDD.tar.gz
                                Old card model doesn't fit the new schema.
                                Keep the archive for reference / future grep if needed.
~/runn-data/projects/        → already retired in the old Runn; ignore.
~/projects/runn/             → the OLD Runn codebase. Don't run it on the NUC.
                                Keep the repo on GitHub as historical reference.
```

---

## 6. NUC bootstrap

1. Install Debian 12 (stable) or Ubuntu 24.04 LTS to the NVMe.
2. Create user `waz` with sudo. SSH-copy-id the existing public key so the
   old host can rsync in.
3. Install packages: `docker`, `docker-compose`, `nodejs` (v20+), `git`,
   `wireguard`, `rsync`, `gh` (GitHub CLI).
4. Configure WireGuard from copied configs in `/etc/wireguard/`. Verify each
   tunnel comes up: `ssh -F ~/.ssh/config rc_nuci5a echo ok` etc.
5. `gh auth login` via browser flow. Confirm `gh repo list` works.
6. Install Claude Code (desktop app or CLI). Sign in with the same Anthropic
   account. The OAuth refresh will happen on first spawn.

---

## 7. Data copy (run on NUC, pulling from old host)

```bash
# From the NUC, with ssh access to the old host:
OLD=waz@old-host

rsync -avzP --delete $OLD:/home/waz/runn-data/clients/   /home/waz/runn-data/clients/
rsync -avzP --delete $OLD:/home/waz/runn-data/invoices/  /home/waz/runn-data/invoices/
rsync -avzP          $OLD:/home/waz/runn-data/settings.json /home/waz/runn-data/
rsync -avzP --delete $OLD:/home/waz/projects/   /home/waz/projects/
rsync -avzP --delete $OLD:/home/waz/.claude/    /home/waz/.claude/
rsync -avzP --delete $OLD:/home/waz/.ssh/       /home/waz/.ssh/

# Archive (NOT import) the old cards:
mkdir -p /home/waz/runn-archive
ssh $OLD 'tar -czf - -C /home/waz/runn-data cards' > /home/waz/runn-archive/cards-$(date +%Y%m%d).tar.gz
```

---

## 8. Build sequence for Runn 2

Greenfield repo: `~/projects/runn2/`. Suggested stack — same pattern as old
Runn (proven, simple):

- Single-file vanilla-JS frontend (`frontend/index.html`)
- Small Node backend (`worker/server.js`) on port `17777`
- Docker container `runn2` with bind-mounts for `frontend/`, `~/runn-data/`,
  `~/.claude/`, `~/projects/`, `~/.ssh:ro`
- WebSocket for live UI updates
- MCP permission server (reuse the pattern — `worker/mcp-permission.js`)

Build order (incremental, each step shippable):

1. **Backend skeleton**: `/streams` CRUD, `/clients` (already populated by
   the copy step), `/settings`. WebSocket broadcaster.
2. **Frontend skeleton**: 2-pane layout. Left = chat input + stream list
   (no search yet, just chronological). Right = stream chat view (read-only
   for now).
3. **Send turn**: typing in the chat input creates a new stream (no client
   assigned) and posts the first turn. AI is NOT spawned yet — just storage.
4. **AI client proposal**: after first turn, call Claude with a tiny prompt
   ("given this first message, which client?") and surface a confirm chip.
5. **AI spawn**: assigned-client streams spawn Claude in the client's cwd,
   stream-json output parsed like old Runn.
6. **Heuristic search**: fuzzy text match in the list. Lowercase substring +
   recency ranking is fine; no fancy lib needed.
7. **Hours tracking**: live timer same shape as old Runn (start when AI is
   spawned or user starts typing; stop on done / blur for human streams).
8. **Status & lifecycle**: status chip on each stream; transitions.
9. **Billing view**: outstanding rollup per client; reuse old Runn's
   formulas (hours × rate, GST, currency).
10. **Invoice composer**: pull done+unbilled streams for a client. AI
    suggests project groupings; user can drag streams between groupings.
11. **Invoice issue**: POST `/invoices`; flip stream status to `invoiced`.
    Reuse the existing invoice JSON shape (with `items[].stream_id`).
12. **Worktree per stream** (was Phase B in the old plan):
    - For streams whose client workspace is a git repo, create a worktree
      at `~/runn-worktrees/<stream-id>/` on branch `runn/<stream-id>`.
    - Auto-commit at end of each AI session; auto-push to GitHub
      (`feedback-git-github-default` memory: push is the backup).
    - "Mark stream done" button = merge branch to main, push, delete worktree.
    - UI language: "saved" / "backed up" / "merged" — never "commit/push/merge".

Skip from old Runn (intentionally not carried):
- `worker/cron.js` sketch (never wired in old Runn either).
- The plan-then-apply tier — revisit later if needed; not core to v1.
- Drag-to-reorder (no task list to reorder anymore).
- Project-level Runn-mode switch (replaced by per-stream status).

---

## 9. Cutover

- Old machine stays running and read-only — no new streams created there.
- New work goes straight to the NUC.
- Run both for ~1 week. Migrate any half-done streams manually by copying
  the conversation into a new NUC stream.
- When confident: snapshot the old machine (`tar -czf` of `~/runn-data`,
  `~/projects`, `~/.claude`) to external storage, then power down the big
  box.

---

## 10. Open decisions during build

These were discussed but not fully resolved — let them surface as the user
hits them in practice rather than deciding upfront:

- **Status set granularity**. Probably: `open / doing / review / done /
  invoiced / paid / blocked / hold`. Drop `queued` (no queue concept anymore
  without the task layer). Drop `invoice` (the staging status — folded into
  `done`).
- **Long-stream context limits**. A single chat that gets very long will
  eventually strain Claude's context window. Not solving upfront. When user
  hits it, options are: (a) "fork stream" button, (b) auto-summarise older
  turns, (c) just trim. Add when needed.
- **Hours: live timer vs estimate**. Old Runn ran a live timer; keep that
  shape unless it proves annoying.
- **Permission mode default per client**. Inherit per-client setting like
  old Runn. Default `default` (ask each time) for new clients.

---

## 11. Memory to carry forward

The auto-loaded memory at `~/.claude/projects/-home-waz-projects-runn/memory/`
on the old machine should be copied to the equivalent path on the NUC. Key
memories already relevant to Runn 2:

- `feedback_git_github_default.md` — push to GitHub is the backup default;
  never expose raw git terms.
- `feedback_terse_chat_mode.md` — terse Q&A, drop TL;DR, one question at
  a time, fatigue avoidance.
- `git_workflow_main.md` — commit + push, narrate for a git beginner.
- `project_runn_mission.md` — household + client mix, "illusion of security".
- `runn_spawn_env_node_only.md` — Runn-spawned containers are Node-only
  (no python3/jq/column).

The path will need updating if the new repo lives at `~/projects/runn2/`
instead of `~/projects/runn/` — Claude Code derives the memory project
slug from cwd.

---

TL;DR: clean rebuild on NUC; stream-only data model; copy clients +
invoices + settings + workspaces + .claude verbatim; archive old cards
unimported; build new Runn in 12 incremental shippable steps.
