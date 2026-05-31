# Runn 2.0 — fresh build on the NUC

A clean-room rebuild of Runn from a refinement conversation that radically
simplified the data model. Hardware moves from the current big box to a
Gen 12 i5 NUC with 64GB / Gen4 NVMe.

This doc briefs the host's Claude Code desktop session: model + migration +
build sequence. Self-contained — does not require reading the old codebase.

---

## 1. The new model (locked)

**One object: the job. A job _is_ one long chat that spans days.** The unit
of work, the unit of conversation, and the unit of billing are the same
object. No separate "task" or "card" layer.

We pressure-tested the earlier "one object: the stream" idea (one chat = one
billable line) and it broke: in real work a billable job commonly sprawls
across several sittings over days. Making each chat its own invoice line
produced many fragments that only the project grouping tied together — so
that grouping was load-bearing, not cosmetic. The fix is to define the object
as the **job**, where what used to be "several chats" become dated
session-dividers inside a single continuous thread. Billing-atom and
conversation-atom are the same thing again; the only real cost is the
context-window limit on a long thread (see "Context", below).

- **Job** = one long chat with AI, spanning multiple days/sessions. Has
  turns, hours, status, client, billing identity. **This is the billable
  unit** — one invoice line per job. Sessions within it are just dated
  dividers in the thread, not separate objects.
- **Client** = who it's for. Carries billing identity (rate, currency, GST,
  invoice prefix, workspace slug). One client = one cwd (per Claude Code
  conventions — the cwd is what Claude Code calls a "project").
- **Invoice** = one line item per job, optionally grouped under client/topic
  headings for layout neatness.

**Context (how a single long chat survives the window).** Two mechanisms,
belt-and-braces:
- *Compaction* — Claude Code's built-in auto-compaction summarises older
  turns when the window fills. It is automatic; no manual trigger. To the
  user the chat still looks continuous.
- *AI-run notes file* — compaction is lossy, so each job keeps a lossless
  running-notes markdown file the **AI maintains itself, updated after every
  turn** (key decisions, current state, what's done, open threads). On every
  resume it reads this file first. Even if compaction forgets the
  play-by-play, the load-bearing facts survive. Cost is a little extra
  time/tokens per turn — accepted, for never losing the thread.

What goes away from the old Runn:
- The "+ Project" button and the project layer as a thing you create.
- The task/card layer. No subtasks, no cards under anything.
- Pane 2 navigation through projects.

What stays:
- Per-client billing identity (`rate_per_hour`, `currency`, `gst_rate`, etc.).
- The invoice format (described as "near perfect" in refinement).
- Hours tracking on the unit of work (now the job).
- Per-cwd lock (one client's workspace = one Claude writer at a time).
- The MCP permission gate (see section 2 — non-negotiable).
- Plan-then-apply approval flow.

---

## 2. Hard constraints (non-negotiable)

These are not features — they are the security boundary. Every other
decision yields to them.

**All tool access goes through MCP. No raw shell into client networks.
No raw SSH.**

The old Runn already routed every Write/Edit/Bash through a custom
permission MCP server (`mcp__runn__ask_permission`). Runn 2 extends this
and treats it as load-bearing:

- The permission gate is mandatory for every spawn. Not optional, not a
  user-toggle, not a per-client override.
- Each client workspace gets its own MCP ops server (`<client>-ops`)
  exposing a curated set of tools — e.g. `ssh_exec_on_known_host(host,
  command)`, `read_zfs_status(pool)`, `restart_named_service(name)`. These
  are the **only** way the spawned Claude reaches the client's networked
  machines.
- The spawned Claude cannot type `ssh user@host …` in Bash and have it
  work. The MCP layer intercepts. Bash is for local-workspace operations
  only (file edits, npm, git inside the worktree). Anything that crosses
  a network boundary must be a curated MCP tool call.
- The `raw_ssh_exec` escape hatch from the old Runn (carried over from
  commit `9771080`) is preserved for cases where no curated tool fits.
  It is human-gated per call and blocked from blanket approval, exactly
  like `apply_plan`. Use is auditable in stderr.
- A new client onboarded without an ops MCP server can read its own
  workspace and edit files there, but reaches no networked machine until
  a curated ops server is written. This is a feature, not a gap — it
  forces the per-client tool surface to be deliberate.

**Why this matters.** A spawned Claude with `bypassPermissions` AND raw
shell access AND the operator's SSH keys is a pivot point into every
client network simultaneously. The MCP layer is the only thing that
prevents a hallucinated `ssh root@prod-db rm -rf /` from being
executable. Runn 2 must not trade this for ergonomics.

**Build implication.** MCP scaffolding is **step 1** of the build
sequence below — before the frontend, before `/jobs` CRUD. The
frontend can be sketchy while MCP is solid; never the inverse.

---

## 3. UX shape

**Two panes** (was three):
- **Left**: a list of **jobs** (jobs only — no nested chat/card rows, because
  a job _is_ the chat). Search-filtered (heuristic fuzzy text on title + body
  + client name, ranked by recency). At the bottom: a **"+ Job"** action that
  starts a new job.
- **Right**: the open job's chat (turn-by-turn bubbles, with dated session
  dividers), or the billing/invoice view when you're in those. Its own chat
  input lives here.

**Job metadata** (client chip, status, hours, due) lives in the chat's
header — not in a sidebar.

**Two inputs — the gesture decides new-vs-continue.** This is the key
simplification over the original single-input plan, which forced the AI to
guess whether each message started a new job or continued one:
- **"+ Job"** (left pane) → unambiguously starts a **new** job.
- Typing into the **open chat** (right pane) → unambiguously **continues**
  that job.

So the AI never has to infer new-vs-continue. Its only entry-time inference
shrinks to proposing **which client** a brand-new job belongs to.

**Entry flow** (the "fix server A" emergency case):
1. Open Runn → hit "+ Job", cursor lands in a fresh chat input.
2. Type the question and send.
3. AI reads the first turn and proposes a client ("looks like ZIS — confirm?").
4. User accepts or picks a different client with one tap.
5. Job is now classified and recorded; the AI names it from the first turn.

**No upfront ceremony.** No client picker before typing, no project picker
ever, no template, no required title (AI names the job from the first turn).

---

## 4. Data model

```
jobs/<id>.json            (the billable unit = one long multi-day chat)
  id, client_id, title (AI-named, user-editable),
  status: open | doing | review | done | invoice | invoiced | paid | blocked | hold,
  created_at, updated_at, done_at,
  hours (number),
  turns: [{ role: 'user' | 'ai', text, at, session_event?, ... }],
            (session_event marks dated session/day dividers within the one
             continuous thread — sessions are not separate objects)
  session_id?  (Claude Code session, for --resume),
  invoice_summary? (client-facing one-line description of the work, SEPARATE
                    from `title`: title is the short internal nav label
                    ("ZIS tunnel"), invoice_summary is the billing line
                    ("Diagnosed and fixed recurring WireGuard tunnel drops").
                    AI maintains it live from the notes file as the chat
                    evolves; regenerate/edit at invoice time),
  invoice_group? (optional cosmetic grouping of jobs on an invoice — layout
                  only, not load-bearing; refined later, see section 11),
  invoice_id?, invoice_line_id?,
  archived: bool

jobs/<id>.notes.md        (the AI-run running-notes file for this job)
  Lossless companion to the chat. The AI maintains it ITSELF, updated after
  every turn: key decisions, current state, what's done, open threads. Read
  first on every resume so the load-bearing facts survive compaction.

clients/<id>.json
  Carry forward verbatim from old Runn — schema is fine.
  id, name, workspace (slug under ~/projects/), rate_per_hour, currency,
  gst_rate, non_billable, invoice_prefix, invoice_seq, notes_md.

invoices/<id>.json
  Carry forward; items[].job_id replaces items[].card_id. One item per job.
  Otherwise identical: snapshot, subtotal_ex_gst, gst, total_inc_gst, paid, etc.

settings.json
  Carry forward verbatim — business info, defaults.
```

Note: the old `billing_projects/<id>.json` object is dropped. With jobs now
multi-day chats, the job _is_ the grouping; any on-invoice grouping of
multiple jobs is pure layout (`invoice_group` label above) and refined when
we get to the invoice composer.

---

## 5. What carries forward from the old machine

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

## 6. What gets archived but NOT imported

```
~/runn-data/cards/           → tar+gzip into /home/waz/runn-archive/cards-YYYYMMDD.tar.gz
                                Old card model doesn't fit the new schema.
                                Keep the archive for reference / future grep if needed.
~/runn-data/projects/        → already retired in the old Runn; ignore.
~/projects/runn/             → the OLD Runn codebase. Don't run it on the NUC.
                                Keep the repo on GitHub as historical reference.
```

---

## 7. NUC bootstrap

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

## 8. Data copy (run on NUC, pulling from old host)

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

## 9. Build sequence for Runn 2

Greenfield repo: `~/projects/runn2/`. Suggested stack — same pattern as old
Runn (proven, simple):

- Single-file vanilla-JS frontend (`frontend/index.html`)
- Small Node backend (`worker/server.js`) on port `17777`
- Docker container `runn2` with bind-mounts for `frontend/`, `~/runn-data/`,
  `~/.claude/`, `~/projects/`, `~/.ssh:ro`
- WebSocket for live UI updates
- MCP permission server (reuse the pattern — `worker/mcp-permission.js`)

Build order (incremental, each step shippable):

1. **MCP scaffolding first** (section 2 — non-negotiable; the rest of the
   stack assumes it). Bring up before any UI:
   - `worker/mcp-permission.js` — the `ask_permission` gate. Copy verbatim
     from old Runn; this code is proven and the protocol shape matters more
     than its prettiness.
   - Per-client ops server template (`worker/lthcs-ops.js` style). Port
     each existing client's curated tool set (`lthcs-ops-tools/*.js` etc.).
   - Per-cwd MCP config generation in `bridge.js` (the `/tmp` config-file
     pattern). The spawned Claude gets the permission gate + the matching
     `<client>-ops` server based on cwd prefix.
   - The `raw_ssh_exec` human-gated escape hatch (carried from old Runn
     commit `9771080`). Blocked from blanket approval like `apply_plan`.
   - **Acceptance test**: a spawned Claude in any client workspace, asked
     to `ssh user@host echo hi` via Bash, gets routed through
     `ask_permission` and the operator can decline. No path bypasses this.
2. **Backend skeleton**: `/jobs` CRUD, `/clients` (already populated by
   the copy step), `/settings`. WebSocket broadcaster.
3. **Frontend skeleton**: 2-pane layout. Left = job list + "+ Job" button
   (no search yet, just chronological). Right = job chat view (read-only
   for now).
4. **Send turn**: "+ Job" creates a new job (no client assigned) and posts
   the first turn; typing into an open job's chat continues it. AI is NOT
   spawned yet — just storage.
5. **AI client proposal**: after the first turn of a new job, call Claude
   with a tiny prompt ("given this first message, which client?") and
   surface a confirm chip. (New-vs-continue is decided by the gesture, not
   inferred — see section 3.)
6. **AI spawn**: assigned-client jobs spawn Claude in the client's cwd,
   stream-json output parsed like old Runn. The MCP config from step 1
   is wired into every spawn — no spawn without the permission gate.
7. **Plan-then-apply approval** (carry from old Runn commit `995623c`).
   Mutating tool calls go through plan storage → human approval → apply.
   Non-trivial to design from scratch but proven in old Runn's code; port
   `worker/server.js:875–921` and the matching frontend modal.
8. **Heuristic search**: fuzzy text match in the list. Lowercase substring +
   recency ranking is fine; no fancy lib needed.
9. **Hours tracking**: live timer same shape as old Runn (start when AI is
   spawned or user starts typing; stop on done / blur for human jobs).
10. **Status & lifecycle**: status chip on each job; transitions.
11. **Billing view**: outstanding rollup per client; reuse old Runn's
    formulas (hours × rate, GST, currency).
12. **Invoice composer**: pull done+unbilled jobs for a client; one line per
    job. Each line's text is the job's `invoice_summary` (AI-maintained
    client-facing one-liner, distinct from the internal `title`); the
    composer can regenerate or let the user edit it before issuing. AI
    suggests cosmetic `invoice_group` headings; user can drag jobs between
    groupings. (Grouping is layout-only — to be refined here.)
13. **Invoice issue**: POST `/invoices`; flip job status to `invoiced`.
    Reuse the existing invoice JSON shape (with `items[].job_id`).
14. **Worktree per job** (was Phase B in the old plan):
    - For jobs whose client workspace is a git repo, create a worktree
      at `~/runn-worktrees/<job-id>/` on branch `runn/<job-id>`.
    - Auto-commit at end of each AI session; auto-push to GitHub
      (`feedback-git-github-default` memory: push is the backup).
    - "Mark job done" button = merge branch to main, push, delete worktree.
    - UI language: "saved" / "backed up" / "merged" — never "commit/push/merge".

Skip from old Runn (intentionally not carried):
- `worker/cron.js` sketch (never wired in old Runn either).
- Drag-to-reorder (no task list to reorder anymore).
- Project-level Runn-mode switch (replaced by per-job status).
- The old "client" → workspace migration scripts (one-shot, done on old
  machine, not relevant to NUC).

---

## 10. Cutover

- **Hard prerequisite for cutover**: every client that the operator
  actively works with must have its ops MCP server ported to Runn 2
  before the NUC takes over for that client. A spawn into a client
  workspace without its ops server can only edit local files; it cannot
  reach the client's machines. Triage list: LTHCS, ZIS, and any client
  with networked-host tools in `lthcs-ops-tools/` style today.
- Old machine stays running and read-only — no new jobs created there.
- New work goes straight to the NUC.
- Run both for ~1 week. Migrate any half-done jobs manually by copying
  the conversation into a new NUC job.
- When confident: snapshot the old machine (`tar -czf` of `~/runn-data`,
  `~/projects`, `~/.claude`) to external storage, then power down the big
  box.

---

## 11. Open decisions during build

These were discussed but not fully resolved — let them surface as the user
hits them in practice rather than deciding upfront:

- **Status set granularity**. Probably: `open / doing / review / done /
  invoiced / paid / blocked / hold`. Drop `queued` (no queue concept anymore
  without the task layer). Drop `invoice` (the staging status — folded into
  `done`).
- **Long-job context limits**. The primary approach is now decided (see
  section 1, "Context"): built-in compaction + an AI-run lossless notes
  file. This open item is only the escape hatch if a single job still grows
  monstrous despite that — options: (a) "fork job" button, (b) heavier
  manual summarisation, (c) just trim. Add when needed.
- **Hours: live timer vs estimate**. Old Runn ran a live timer; keep that
  shape unless it proves annoying.
- **Permission mode default per client**. Inherit per-client setting like
  old Runn. Default `default` (ask each time) for new clients.

---

## 12. Memory to carry forward

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
- `project_mcp_only_access.md` — MCP is the security boundary; no raw SSH
  or shell to client networks; per-client ops servers define what's reachable.

The path will need updating if the new repo lives at `~/projects/runn2/`
instead of `~/projects/runn/` — Claude Code derives the memory project
slug from cwd.
