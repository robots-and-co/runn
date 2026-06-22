# Runn — clean-room rebuild on the NUC

A clean-room rebuild of Runn from a refinement conversation that radically
simplified the data model. It keeps the name **Runn** (not "Runn 2"): the new
build replaces the old one in place — same repo, same canonical
`~/projects/runn` path — with the old card-based code retained only as git
history. Hardware moves from the current big box to a Gen 12 i5 NUC with
64GB / Gen4 NVMe.

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
- **Invoice** = a flat one-line-per-job list. No topic headings or grouping
  object; when jobs are related, the AI shows it inline in the line text via
  a shared context phrase ("— internet down") at invoice time.

**Context (how a single long chat survives the window).** Two mechanisms,
belt-and-braces:
- *Compaction* — Claude Code's built-in auto-compaction summarises older
  turns when the window fills. It is automatic; no manual trigger. To the
  user the chat still looks continuous.
- *Runn-driven notes file* — compaction is lossy, so each job keeps a
  lossless running-notes markdown file (key decisions, current state, what's
  done, open threads). It is **not** left to the main agent's self-discipline
  (a directive can slip); instead **Runn drives it**: after each turn lands,
  Runn fires a small dedicated step that rewrites the notes from the latest
  turn + the current notes. On every resume the file is injected first so the
  agent starts with current state. Even if compaction forgets the
  play-by-play, the load-bearing facts survive. It's a living document
  (rewritten/condensed), not an append-only log. Cost: one cheap extra call
  per turn (small model, minimal context) — accepted, for never losing the
  thread.

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
permission MCP server (`mcp__runn__ask_permission`). The rebuild extends this
and treats it as load-bearing:

- The permission gate is mandatory for every spawn. Not optional, not a
  user-toggle, not a per-client override.
- Each client workspace gets its own MCP ops server (`<client>-ops`)
  exposing a curated set of tools — e.g. `ssh_exec_on_known_host(host,
  command)`, `read_zfs_status(pool)`, `restart_named_service(name)`. These
  are the **only** way the spawned Claude reaches the client's networked
  machines. Because per-job worktrees let multiple jobs run in parallel for
  one client (see step 14), the ops server **serializes its tool calls per
  client** — a per-client mutex so sibling jobs can't fire ops against the
  same live infrastructure simultaneously; concurrent calls queue.
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
executable. The rebuild must not trade this for ergonomics.

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
  status: open | doing | review | done | invoiced | paid | blocked | hold,
            (review = AI is waiting on the HUMAN's response — a question,
             approval, or decision. The AI sets it ONLY when it genuinely
             needs the human to reply, never just to say "have a look".
             blocked = waiting on something/someone OTHER than the human —
             a third party, an outage. The two are distinct.)
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
                    evolves; regenerate/edit at invoice time. Relatedness
                    between jobs is shown INLINE here via a shared context
                    phrase ("— internet down"), added by an AI pass at
                    invoice time — there is no separate grouping object),
  invoice_id?, invoice_line_id?,
  archived: bool

jobs/<id>.notes.md        (the Runn-driven running-notes file for this job)
  Lossless companion to the chat. RUNN drives the update (not the main agent's
  self-discipline): after each turn lands, a small dedicated call rewrites it
  from the latest turn + current notes. A living document (rewritten/condensed,
  not append-only): key decisions, current state, what's done, open threads.
  Injected first on every resume so the load-bearing facts survive compaction.
  Source for the job's invoice_summary.

clients/<id>.json
  Carry forward from old Runn — schema is fine, plus backup fields below.
  id, name, workspace (slug under ~/projects/), rate_per_hour, currency,
  gst_rate, non_billable, invoice_prefix, invoice_seq, notes_md,
  backup_repo? (private GitHub repo under robots-and-co, set up on first use),
  backup_ready? (bool — true once init+push done, so setup runs once).

invoices/<id>.json
  Carry forward; items[].job_id replaces items[].card_id. One item per job.
  Otherwise identical: snapshot, subtotal_ex_gst, gst, total_inc_gst, paid, etc.

settings.json
  Carry forward verbatim — business info, defaults.
```

Note: the old `billing_projects/<id>.json` object is dropped, and there is no
grouping object at all. With jobs now multi-day chats, the job _is_ the
grouping. An invoice is a flat one-line-per-job list; when jobs are related,
the AI expresses that inline in `invoice_summary` via a shared context phrase
(e.g. "— internet down") during a pass at invoice creation. No headings, no
drag-between-groups.

---

## 5. What carries forward from the old machine

```
~/runn-data/clients/         → import as-is
~/runn-data/invoices/        → import as-is (historical reference)
~/runn-data/settings.json    → import as-is
~/projects/<slug>/           → rsync (already pushed to GitHub, but copy local
                                 to preserve uncommitted state if any)
~/.claude/                   → rsync (sessions, history, memory all carry)
                                ~565 MB of plain files (305 MB is projects/).
                                No keychain in play — even .credentials.json is
                                a file. Two caveats:
                                (a) AUTH — .credentials.json copies, but don't
                                    trust the copied token; re-run `claude`
                                    sign-in on the NUC (same Anthropic account).
                                (b) PATH FIDELITY — sessions + memory are keyed
                                    by cwd slug (e.g. -home-waz-projects-runn).
                                    They only resolve if /home/waz/... paths are
                                    identical. Because the rebuild keeps the
                                    ~/projects/runn path, the slug is unchanged
                                    and memory just auto-loads — no rename
                                    needed (see section 12).
~/.ssh/                      → rsync (keys; known_hosts will rebuild on first use)
/etc/wireguard/              → copy configs as root; re-bring-up tunnels
```

## 6. What gets archived but NOT imported

```
~/runn-data/cards/           → tar+gzip into /home/waz/runn-archive/cards-YYYYMMDD.tar.gz
                                Old card model doesn't fit the new schema.
                                Keep the archive for reference / future grep if needed.
~/runn-data/projects/        → already retired in the old Runn; ignore.
old card-based Runn code     → it's the PRIOR HISTORY of this same repo (we keep
                                the name "Runn"). Tag it before the rewrite
                                (e.g. `git tag v1-cards`) so it's recoverable,
                                then build the new Runn over it in place. Don't
                                check out / run the old commits on the NUC.
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

# AUTH: don't trust the copied token — re-sign-in on the NUC (same account):
claude   # then complete the sign-in / OAuth flow once

# MEMORY SLUG: the rebuild keeps the ~/projects/runn path, so the
# -home-waz-projects-runn memory slug is unchanged and auto-loads as-is.
# No rename needed (this is why keeping the name "Runn" simplifies migration).

# Archive (NOT import) the old cards:
mkdir -p /home/waz/runn-archive
ssh $OLD 'tar -czf - -C /home/waz/runn-data cards' > /home/waz/runn-archive/cards-$(date +%Y%m%d).tar.gz
```

---

## 9. Build sequence for Runn

Clean-room rewrite in place at `~/projects/runn/` (same repo, old card-based
code tagged in history — see section 6). Suggested stack — same pattern as old
Runn (proven, simple):

- Single-file vanilla-JS frontend (`frontend/index.html`),
  **mobile-breakpoint first-class** (see below)
- Small Node backend (`worker/server.js`) on port `17777`
- Docker container `runn` with bind-mounts for `frontend/`, `~/runn-data/`,
  `~/.claude/`, `~/projects/`, `~/.ssh:ro`
- WebSocket for live UI updates
- MCP permission server (reuse the pattern — `worker/mcp-permission.js`)

**Mobile is a first-class target, not a retrofit.** The "fix server A"
emergency case is often typed from a phone. Build the two-pane layout
responsive from step 3: on a narrow viewport the two panes collapse to one
(job list ↔ open chat) with a back gesture, the chat input stays thumb-
reachable and always focused, tap targets are finger-sized, and the
billing/invoice views reflow to a single column. Design the breakpoints up
front; never bolt them on after a desktop-only build.

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
3. **Frontend skeleton**: 2-pane layout, **responsive from the start**. Left =
   job list + "+ Job" button (no search yet, just chronological). Right = job
   chat view (read-only for now). On a narrow (phone) viewport the two panes
   collapse to one with a back gesture; chat input stays thumb-reachable.
   Establish the breakpoints here, before any view is built desktop-only.
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
6b. **Runn-driven notes file** (build alongside step 6; see section 1
   "Context"). After each turn lands, Runn fires a small dedicated call
   (cheap model, minimal context = latest turn + current notes) that rewrites
   `jobs/<id>.notes.md` as a living document. Inject that file first on every
   resume so the agent always starts with current state. Best-effort: if the
   update call fails, the chat still proceeds on the last good notes. This is
   what makes a multi-day job survive compaction losslessly.
7. **Plan-then-apply approval** (carry from old Runn commit `995623c`).
   Mutating tool calls go through plan storage → human approval → apply.
   Non-trivial to design from scratch but proven in old Runn's code; port
   `worker/server.js:875–921` and the matching frontend modal.
8. **Heuristic search**: fuzzy text match in the list. Lowercase substring +
   recency ranking is fine; no fancy lib needed.
9. **Hours tracking**: live timer that accrues **active work only**, never
   calendar time (a job spans days but isn't worked continuously). Runs while
   the AI is processing OR the user is in the open job (typing/reading);
   **auto-pauses after a short idle gap** so walking away with a chat open
   doesn't bill. Accumulates into the job's `hours`, which stays
   **hand-editable** — the timer proposes, the user can round/correct before
   invoicing.
10. **Status & lifecycle**: status chip on each job; transitions.
11. **Billing view**: outstanding rollup per client; reuse old Runn's
    formulas (hours × rate, GST, currency).
12. **Invoice composer**: pull done+unbilled jobs for a client; one flat line
    per job. Each line's text is the job's `invoice_summary` (AI-maintained
    client-facing one-liner, distinct from the internal `title`); the
    composer can regenerate or let the user edit it before issuing. With all
    the client's jobs visible, an AI pass tags related jobs with a shared
    inline context phrase ("— internet down") — editable. No headings, no
    grouping object, no drag-between-groups.
13. **Invoice issue**: POST `/invoices`; flip job status to `invoiced`.
    Reuse the existing invoice JSON shape (with `items[].job_id`).
14. **Worktree per job** (was Phase B in the old plan):
    - **Ensure backup first.** The first time a job touches a client
      workspace that isn't yet a git repo, Runn quietly **sets up backup**:
      `git init` → create a **private** GitHub repo under the
      **`robots-and-co`** org (named from the workspace slug) → initial
      commit + push + set upstream. Private is non-negotiable (client data).
      In plain language only ("setting up backup") — never raw git terms
      (`feedback-git-github-default`). Store the repo URL / backup status on
      `clients/<id>.json` so it's a one-time setup. This makes the worktree
      flow below universal — every workspace becomes git-backed.
    - For jobs whose client workspace is a git repo, create a worktree
      at `~/runn-worktrees/<job-id>/` on branch `runn/<job-id>`.
    - Auto-commit at end of each AI session; auto-push to GitHub
      (`feedback-git-github-default` memory: push is the backup).
    - "Mark job done" button = merge branch to main, push, delete worktree.
      If the merge can't apply cleanly, surface it in plain language ("these
      changes overlap — need a hand") — never auto-discard either side.
    - UI language: "saved" / "backed up" / "merged" — never "commit/push/merge".
    - **Two-tier concurrency** (supersedes old Runn's single per-cwd lock —
      see `project_no_parallel_ai`): because each job has its own worktree,
      jobs in the SAME client run **in parallel** at the file level — the
      lock moves from per-client-tree to **per-worktree**. BUT worktrees
      isolate files, not the client's live machines: every sibling job hits
      the same `<client>-ops` MCP server. So ops-MCP calls (and
      `raw_ssh_exec`) are **serialized per client** — a per-client mutex
      around ops-tool execution; concurrent calls from sibling jobs queue and
      fire one at a time. Net: think/edit/plan in parallel; touch the live
      infrastructure one action at a time, in order.

Skip from old Runn (intentionally not carried):
- `worker/cron.js` sketch (never wired in old Runn either).
- Drag-to-reorder (no task list to reorder anymore).
- Project-level Runn-mode switch (replaced by per-job status).
- The old "client" → workspace migration scripts (one-shot, done on old
  machine, not relevant to NUC).

---

## 10. Cutover

- **Hard prerequisite for cutover**: every client that the operator
  actively works with must have its ops MCP server ported to the rebuild
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

- **Status set granularity** — DECIDED. The conveyor is `open / doing /
  review / done / invoiced / paid / blocked / hold`. Dropped `queued` (no
  queue concept without the task layer) and `invoice` (staging status folded
  into `done`). Key marking rule: the AI sets `review` ONLY when it needs the
  human's response (question/approval/decision), and `blocked` when waiting on
  something/someone other than the human. This rule must live in the spawn
  directive / status-update tool semantics so the AI follows it (see
  section 4).
- **Long-job context limits**. The primary approach is now decided (see
  section 1, "Context"): built-in compaction + an AI-run lossless notes
  file. This open item is only the escape hatch if a single job still grows
  monstrous despite that — options: (a) "fork job" button, (b) heavier
  manual summarisation, (c) just trim. Add when needed.
- **Hours timer** — DECIDED. Live timer counting **active work only** (AI
  processing OR user in the open job), auto-pausing after a short idle gap so
  calendar time isn't billed. `hours` is **hand-editable** before invoicing —
  the timer proposes, the user can round or correct. Only open sub-detail: the
  exact idle threshold (tune in build step 9).
- **Permission mode default per client**. Inherit per-client setting like
  old Runn. Default `default` (ask each time) for new clients.

---

## 12. Memory to carry forward

The auto-loaded memory at `~/.claude/projects/-home-waz-projects-runn/memory/`
on the old machine should be copied to the equivalent path on the NUC. Key
memories already relevant to the rebuild:

- `feedback_git_github_default.md` — push to GitHub is the backup default;
  never expose raw git terms.
- `feedback_terse_chat_mode.md` — terse Q&A, lead with a one-line TL;DR, one
  question at a time, fatigue avoidance.
- `git_workflow_main.md` — commit + push, narrate for a git beginner.
- `project_runn_mission.md` — household + client mix, "illusion of security".
- `runn_spawn_env_node_only.md` — Runn-spawned containers are Node-only
  (no python3/jq/column).
- `project_mcp_only_access.md` — MCP is the security boundary; no raw SSH
  or shell to client networks; per-client ops servers define what's reachable.

No path update needed: the rebuild keeps the canonical `~/projects/runn`
cwd, so the memory project slug Claude Code derives from cwd is unchanged
and these memories auto-load as-is.
