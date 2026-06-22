# Runn's AI engine — how it works (single-app reference)

> **History:** this file began as a task brief to port V1's gated AI engine into
> the "V2 rebuild." That port is **complete**. On 2026-06-15 V2 became the one
> and only Runn: it is `main` at `/home/waz/projects/runn`, V1 is archived as the
> `v1-archive` branch, and the old `rebuild` branch / `runn-rebuild` worktree /
> `runn-rebuild.service` are gone. There is now **one codebase, one service, one
> app.** This doc is kept as a description of how the live engine works.
>
> All file:line references are **as last observed** — line numbers drift, so
> re-grep `worker/*.js` to confirm before relying on any of them. **Trust but
> verify.**

---

## 0. THE APP IN ONE LINE

When a user sends a message to a job, a `claude` process spawns (or resumes) in
that job's client workspace, **asks the user before every write/command** (the
gated permission model), and streams its replies back into the job's chat live —
with the work-clock and status conveyor driving the job through `doing → review`.

**Settled decision: gated permissions.** Claude must ask the human before each
Write/Edit/Bash, surfaced in the UI. There is no auto-approve-everything mode.

---

## 1. ABSOLUTE CONSTRAINTS (read before touching anything)

1. **MCP-only access for spawned Claudes is NON-NEGOTIABLE.** A spawned Claude
   must NOT get raw shell/SSH into client networks. All file ops + commands flow
   through the `runn` permission MCP server (which calls back to Runn for a
   human decision). Per-client infra reach is ONLY via the curated
   `<client>-ops` MCP server (e.g. `lthcs-ops`). See `worker/bridge.js` +
   `worker/mcp-permission.js`.
2. **Per-cwd write lock.** Never two AI writers in the same working directory.
   `bridge.js` implements a per-cwd mutex (`claimCwd`/`releaseCwd`, queue on
   contention). Read-only spawns may run in parallel; writers in one tree may not.
3. **One codebase.** The live app is `main` at `/home/waz/projects/runn`. Edit
   here. (V1 lives only as the archived `v1-archive` branch — reference, never
   edited or deployed.)
4. **Never print or commit secrets.** A GoDaddy API token lives in
   `/etc/caddy/godaddy.env` — never echo or commit it. Don't commit
   `.env`/credentials.
5. **Don't reconfigure the public edge / DNS.** `runn.robotsand.co` is fronted by
   Caddy (TLS via GoDaddy DNS) → `localhost:17778`. The user owns router/DNS/edge.
6. **Spawned task env is Node-only** (no python3/jq/column). Claude is NOT
   containerised per job — `bridge.js` spawns the `claude` CLI as a plain
   detached child of the worker, in the worker's own env. Helper scripts you
   write for parsing must be `node -e`.
7. **Don't skip git hooks** (`--no-verify`, `--no-gpg-sign`) unless the user asks.
   Fix the underlying issue if a hook fails.

---

## 2. COMMUNICATION & GIT STYLE (the user)

- The user is **dyslexic** — keep chat replies **tight** and **lead every reply
  with a one-line `TL;DR:`** so they can stop after one line, **one question per
  turn**, expand only on request.
- **Never use the `§` symbol** — write "section N".
- The user **does not deeply know git**. Narrate git steps in plain language
  ("saved", "backed up to GitHub", "merged") — not raw jargon. The UI must never
  show raw git terms.
- The user wants work **committed AND pushed** as the definition of "saved" —
  treat a successful GitHub push as the backup/success criterion. Push to
  `origin/main`. Use the `Co-Authored-By` trailer.
- **Test UI in a real browser before claiming done** (use the Preview MCP tools).

---

## 3. RUNTIME TOPOLOGY (the single app)

- **Codebase:** `/home/waz/projects/runn`, branch `main`. Pushes go to
  `origin/main` (`git@github.com:robots-and-co/runn.git`).
- **Service:** systemd `runn.service` (native, not Docker), `WorkingDirectory=
  /home/waz/projects/runn`, `ExecStart=node worker/server.js`, **port 17778**,
  `RUNN_DATA=/home/waz/runn-cards`. Worker (`worker/*.js`) changes need
  `systemctl restart runn.service`; frontend (`frontend/*`) is served from disk
  with `no-store`, so it's live on reload.
- **Gotcha:** Runn-spawned Claude tasks are children of `runn.service`, so
  restarting it kills a running task mid-turn. Have the user restart, or run the
  restart detached/escaped from the service cgroup
  (`sudo systemd-run -p User=waz …`).
- **Data:** the card/job store is `/home/waz/runn-cards` (`RUNN_DATA`). Its
  `clients/` is a symlink into `/home/waz/runn-data/clients` (the real client
  records + client workspaces live under `~/runn-data` / `~/projects/<client>`).
- **Public:** `https://runn.robotsand.co` → Caddy → `localhost:17778`.
- **Host specifics** (which machine, SSH, native-systemd migration) live in the
  auto-memory `project-nuc-native-deploy` — treat that as source of truth rather
  than restating it here, since it drifts.

---

## 4. HOW THE AI ENGINE WORKS

All file:line are **as last observed** — re-grep to confirm.

### 4.1 Invocation
- **Endpoint:** `POST /jobs/:id/turn` (`worker/server.js`) appends the user turn,
  then — if `role==='user'` — kicks the engine: no `session_id` →
  `bridge.spawnSession(...)` (first spawn); has `session_id` →
  `bridge.sendMessage(...)` (resume `--resume`). The job flips to `doing` (clock
  starts). On cwd contention it returns **202** `{queued:true}` and buffers.
- **`bridge.js` shells out to the `claude` CLI** (`child_process.spawn`,
  `detached:true`, `stdio:['ignore','pipe','pipe']`, `child.unref()` after the
  init event so it survives in the background).
  - First spawn (`spawnSession`):
    ```
    claude -p --output-format stream-json --verbose \
      --mcp-config <cfgPath> \
      --permission-prompt-tool mcp__runn__ask_permission \
      --append-system-prompt <composed> \
      --print <initialPrompt>
    ```
    Initial prompt = `title + "\n\n" + notes_md`. `env` adds `RUNN_PORT` and
    `RUNN_PERMISSION_TOKEN`.
  - Resume (`sendMessage`): identical, plus `--resume <sessionId>` before
    `--print <text>`.

### 4.2 Working directory
- cwd is **derived from the job's `client.workspace`** at spawn time (NOT stored
  on the job): `/home/waz/projects/<workspace>`. Client-less ("Personal") job →
  `bridge.DEFAULT_LOCATION` (`~/runn-data`).
- `clientForCwd(cwd)` maps a cwd under `/home/waz/projects/<client>/` to a client
  key, used to pick the `<client>-ops` MCP server.
- Session transcript path: `~/.claude/projects/<cwdToSlug(cwd)>/<sessionId>.jsonl`
  (`cwdToSlug` replaces `/` etc. with `-`).

### 4.3 MCP config + the permission bridge (THE GATED MODEL)
- `ensureMcpConfig(cwd)` writes `~/tmp/runn-mcp-config-<slug>.json`:
  ```json
  { "mcpServers": {
      "runn": { "type":"stdio", "command":"<node>", "args":["<.../worker/mcp-permission.js>"] },
      "<client>-ops": { "type":"stdio", "command":"<node>", "args":["<.../worker/lthcs-ops.js>"] }
  }}
  ```
  The `runn` server is ALWAYS present; `<client>-ops` is added only when the cwd
  maps to a known client.
- The CLI is told `--permission-prompt-tool mcp__runn__ask_permission`, so every
  Write/Edit/Bash makes Claude call that MCP tool.
- `mcp-permission.js` HTTP-calls back to Runn:
  `http://localhost:<RUNN_PORT>/ai-permission/<RUNN_PERMISSION_TOKEN>/<toolName>`.
  Runn decides `{allow, ...}` from the job's permission mode and — in gated mode —
  **surfaces the request to the human in the browser and waits for approve/deny**
  (broadcast over `/ws`, answered by a POST). This is the trickiest piece — read
  `server.js` (the `/ai-permission` handler) + the frontend permission UI together.

### 4.4 Per-cwd lock
- `activeCwds` Map. `claimCwd(cwd, holder)` throws `{code:'CWD_BUSY'}` if held;
  `releaseCwd(cwd)` on child exit, then `dispatchPendingForCwd` fires the next
  queued message (FIFO per cwd). On contention the HTTP handler returns **202**
  `{queued:true}` and buffers in `pendingMessages` keyed by session.

### 4.5 Streaming back to the browser
- The worker does NOT pipe the child's stdout to the browser. A **chokidar
  watcher on `~/.claude/projects/`** fires on `.jsonl` changes; new turns are
  parsed (`parseTranscript`) and merged into `job.turns[]`, then `writeJob`
  triggers the jobs-dir watcher to broadcast `job.changed` over `/ws` and the UI
  updates live. (Turns are deduped by content/index to avoid duplication on
  repeated writes.)

### 4.6 Status / timer / exit
- Spawn → job `doing` (timer starts; `doing_started_at` stamped).
- `handleJobExit(jobId, code)`: clean exit (0) with nothing queued → `review`;
  non-zero → `blocked`. `patchJob` folds elapsed time into `work_seconds` on
  leaving `doing`.
- **AI NEVER sets `done`** — `done` is a human-only transition (the "✓ Done"
  button). A clean turn lands the job in `review` (waiting on the human);
  `blocked` = waiting on something/someone other than the human.

---

## 5. DATA MODEL

### 5.1 The JOB (`worker/jobs.js`)
A JOB is the whole unit (one long chat — the unit of work + conversation +
billing). Key API: `createJob`, `readJob`, `writeJob`, `patchJob` (patches
scalars AND runs `applyTimerTransition` on status change; sets `done_at` on
done), `setStatus`, `appendTurn({role,text,session_event?,at?})`, `listJobs`,
`readNotes`/`writeNotes` (companion `<id>.notes.md`), `deleteJob`, `JOBS_DIR`.
Schema:
```
{ id, client_id, title, status, created_at, updated_at, due_at, done_at,
  doing_started_at, work_seconds, hours, turns:[{role,text,at,session_event?}],
  session_id, invoice_summary, invoice_id, invoice_line_id, archived }
```
`STATUSES = ['open','doing','review','done','invoiced','paid','blocked','hold']`,
`ROLES = ['user','ai']`. The work clock: time accrues only while
`status==='doing'`; `patchJob` stamps `doing_started_at` on entering `doing` and
folds elapsed seconds into `work_seconds` on leaving.

### 5.2 Clients (`RUNN_DATA/clients`, symlinked to `~/runn-data/clients`)
Each client JSON has a `workspace` string → `cwd = /home/waz/projects/<workspace>`.
Confirmed values (verify against disk): `EFEM→easy-fleet-endpoint-manager`,
`EFITM→easy-fleet-it-manager`, `LTHCS→lthcs` ($150/h, billable), `NGS→ngs`,
`RC→rc`, `Runn→runn`, `Waz→waz`, `ZIS→zis`.

### 5.3 Frontend (`frontend/index.html`, single-file app)
- `sendMsg()` POSTs user turns: `postJson('/jobs/'+id+'/turn', {role:'user',text})`,
  then re-renders. Opens `/ws` and re-renders on `job.added|changed`.
- Thinking UX: an **inline ops bubble** ("thinking bubble" — KEEP it) vs. the
  redundant `#chatThinking` pill. Render AI turns + a thinking state while
  `status==='doing'`, and the permission prompt + approve/deny.
- The mobile chat header is a 3-row grid, space-tight at ≤375px. Don't make it
  worse.

---

## 6. WORKING ON IT (deploy = commit + push)

- Edit in `/home/waz/projects/runn` on `main`. Commit with the `Co-Authored-By`
  trailer and **push to `origin/main`** — that push is the "backup to GitHub" the
  user counts as "saved."
- Because the service runs from this same checkout, pulling/merging on the box and
  restarting `runn.service` updates the live site (`:17778` / `runn.robotsand.co`).
  Restarting kills any in-flight Claude task — coordinate with the user or run the
  restart detached (`sudo systemd-run -p User=waz …`).
- **Test before claiming done:** drive the UI in a real browser (Preview MCP) —
  open a job, send a message, confirm status flips to `doing`, a real `claude`
  child spawns (check `ps` / the session `.jsonl` under `~/.claude/projects/`), a
  permission prompt appears and is answerable, replies stream in, and the job
  lands in `review` with the clock advanced. Verify the per-cwd lock: a second
  concurrent send to the same cwd queues (202). For first tests, prefer a
  throwaway workspace over a real client tree (`lthcs`/`ngs`/`zis`/`rc`).

---

## 7. POINTERS / MEMORY (context not obvious from code)

- Auto-memory store: `/home/waz/.claude/projects/-home-waz-projects-runn/memory/`
  with index `MEMORY.md`. Relevant entries: `project_v2_rebuild_worktree` (the
  cutover — V2 is now `main`), `project-nuc-native-deploy` (host/service/ports),
  `project_mcp_only_access`, `project_no_parallel_ai` (per-cwd lock),
  `runn_spawn_env_node_only`, `project_runn_mission`, `project_thinking_indicators`,
  `project_invoice_numbering`, `billing_no_archive_filter`,
  `git_workflow_main` / `feedback_git_github_default` (commit+push = "saved"),
  `feedback_terse_chat_mode`, `feedback_no_section_symbol`.
- `/home/waz/projects/CLAUDE.md` is the shared client-access primer (SSH, the
  clients lthcs/zis/rc/ngs, safety).

When you finish work, report tightly (the user is terse): what works, how you
tested it in the browser, and that it's pushed. Ask at most one question if
genuinely blocked.
