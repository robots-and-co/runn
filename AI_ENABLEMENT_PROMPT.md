# TASK: Enable the AI engine in Runn V2 (faithful port of V1's gated model)

You are the lead engineer on this. This brief is **self-contained** — it assumes
you have NONE of the prior conversation. Read it fully, then verify every
concrete claim (file paths, line numbers, flags) against the real code before
you rely on it — line numbers drift. **Trust but verify.**

You are encouraged to **spawn subagents** (Explore agents for research, parallel
implementation/verification agents). Orchestrate: delegate the deep reads, keep
synthesis and the actual edits under your own control. Do not delegate
understanding — read the diffs your subagents produce before trusting them.

---

## 0. THE ONE-LINE MISSION

Make Runn **V2** (the "rebuild") actually run Claude as its engine: when a user
sends a message to a job, a `claude` process spawns (or resumes) in that job's
client workspace, **asks the user before every write/command** (V1's gated
permission model), and streams its replies back into the job's chat live — with
the work-clock and status conveyor behaving exactly as V1 did.

**Decision already made by the user: FOLLOW V1.** Gated permissions — Claude
must ask the human before each write/Bash/Edit, surfaced in the UI. Do **not**
ship an auto-approve mode.

---

## 1. ABSOLUTE CONSTRAINTS (read before touching anything)

1. **MCP-only access for spawned Claudes is NON-NEGOTIABLE.** A spawned Claude
   must NOT get raw shell/SSH into client networks. All file ops + commands flow
   through the `runn` permission MCP server (which calls back to Runn for a
   human decision). Per-client infra reach is ONLY via the curated
   `<client>-ops` MCP server (e.g. `lthcs-ops`). Reuse V1's `bridge.js` +
   `mcp-permission.js` so this model is preserved unchanged.
2. **Per-cwd write lock.** Never two AI writers in the same working directory.
   `bridge.js` already implements a per-cwd mutex (`claimCwd`/`releaseCwd`,
   queue on contention). Keep it. Read-only spawns may run in parallel; writers
   in one tree may not.
3. **V1 is READ-ONLY reference.** `/home/waz/projects/runn/` is the live V1 app.
   Read it freely; do NOT edit it without explicit user authorization.
4. **All V2 work happens in `/home/waz/projects/runn-rebuild-dev/`**, git branch
   `rebuild`. That is the target.
5. **Never print or commit secrets.** A GoDaddy API token lives in
   `/etc/caddy/godaddy.env` on the NUC — never echo or commit it. Don't commit
   `.env`/credentials.
6. **Don't reconfigure the public edge / DNS.** `runn.robotsand.co` is fronted
   by an Nginx-Proxy-Manager/openresty edge that now proxies to the NUC. The
   user owns router/DNS/edge. Don't touch it.
7. **Spawned task env is Node-only** (no python3/jq/column in the spawned
   task env). Note: Claude is NOT containerised per job — `bridge.js` spawns the
   `claude` CLI as a plain detached child of the worker, in the worker's own env
   (native systemd on the NUC). Any helper scripts you write for parsing must be
   `node -e`.
8. **Don't skip git hooks** (`--no-verify`, `--no-gpg-sign`) unless the user
   asks. Fix the underlying issue if a hook fails.

---

## 2. COMMUNICATION & GIT STYLE (the user)

- The user is **dyslexic** — keep chat replies **tight**, no "TL;DR" sections,
  **one question per turn**, expand only on request.
- **Never use the `§` symbol** — write "section N".
- The user **does not deeply know git**. Narrate git steps in plain language
  ("saved", "backed up to GitHub", "merged") — not raw jargon. The UI must never
  show raw git terms.
- The user wants work **committed AND pushed** as the definition of "saved" —
  treat a successful GitHub push as the backup/success criterion. Push to
  `origin/rebuild` (the branch the live site tracks). Use `Co-Authored-By` trailer.
- For NUC SSH and `git push`, you must run with `dangerouslyDisableSandbox: true`.
- **Test UI in a real browser before claiming done** (use the Preview MCP tools).

---

## 3. THE TWO CODEBASES & THE RUNTIME TOPOLOGY

- **V1 (reference, READ-ONLY):** `/home/waz/projects/runn/` — the live "card" app.
  Runs on the NUC as systemd `runn.service` on **:17777**. Its AI engine WORKS;
  study it.
- **V2 (target):** `/home/waz/projects/runn-rebuild-dev/` (branch `rebuild`) —
  the job-centric rebuild. Deployed checkout on the NUC is `/home/waz/runn-rebuild`,
  systemd `runn-rebuild.service` on **:17778**, data `/home/waz/runn-rebuild-data`
  (`RUNN_DATA`).
- **You run inside the Runn worker container** on the dev box
  (`waz-B550I-AORUS-PRO-AX`). You see bind-mounts only: `~/runn-data`, `~/.claude`,
  `~/projects`, `~/.ssh` (read-only). `HOME=/home/waz` always.
- **`claude` CLI is installed and logged-in here**: `/home/waz/.local/bin/claude`,
  v2.1.150. **No `ANTHROPIC_API_KEY`** — it uses the logged-in CLI auth. The NUC
  also has it (V1 works there).
- **Public:** `https://runn.robotsand.co` now reverse-proxies to the NUC
  `:17778` (V2). So **deploying to the NUC updates the public site.** TLS is
  handled at the edge + NUC Caddy; it's working.
- **SSH to the NUC:** `ssh -i ~/.ssh/id_rsa -o BatchMode=yes -o ConnectTimeout=10 waz@192.168.50.62`
  (its WireGuard IP is `10.200.255.62`). `sudo systemctl ...` works there.

---

## 4. HOW V1's AI ENGINE WORKS (the thing you are porting)

All file:line are **as last observed** — re-grep to confirm.

### 4.1 Invocation
- **Endpoints (V1 `worker/server.js`):**
  - `POST /cards/:id/ai-ify` (~line 1409) — first spawn (the "play" button):
    validates no sibling is `doing`, resolves the card's location/cwd, calls
    `bridge.spawnSession(...)`, then sets the card → `doing` and starts the timer,
    persists `session_id` + `session_path`.
  - `POST /cards/:id/message` (~line 987) — follow-up turn: calls
    `bridge.sendMessage(...)` (resume).
- **`bridge.js` shells out to the `claude` CLI directly** (`child_process.spawn`),
  `detached: true`, `stdio: ['ignore','pipe','pipe']`, then `child.unref()` after
  the init event so it survives in the background.
  - **First spawn args** (`spawnSession`, ~line 258):
    ```
    claude -p --output-format stream-json --verbose \
      --mcp-config <cfgPath> \
      --permission-prompt-tool mcp__runn__ask_permission \
      --append-system-prompt <composed> \
      --print <initialPrompt>
    ```
    Initial prompt = `title + "\n\n" + notes_md`. `env` adds `RUNN_PORT` and
    `RUNN_PERMISSION_TOKEN`.
  - **Resume args** (`sendMessage`, ~line 379): identical, plus
    `--resume <sessionId>` before `--print <text>`.

### 4.2 Working directory
- cwd is per-client. V1 resolves the card's nearest `location.cwd` (walking the
  parent chain), falling back to `DEFAULT_LOCATION = {type:'local', cwd: ~/runn-data}`.
- `clientForCwd(cwd)` (`bridge.js` ~line 31) maps a cwd under
  `/home/waz/projects/<client>/` to a client key, used to pick the `<client>-ops`
  MCP server.
- Session transcript path: `~/.claude/projects/<cwdToSlug(cwd)>/<sessionId>.jsonl`
  where `cwdToSlug` replaces `/` etc. with `-` (`bridge.js` ~line 75).

### 4.3 MCP config + the permission bridge (THE GATED MODEL — port faithfully)
- `ensureMcpConfig(cwd)` (`bridge.js` ~line 48) writes
  `~/tmp/runn-mcp-config-<slug>.json`:
  ```json
  { "mcpServers": {
      "runn": { "type":"stdio", "command":"<node>", "args":["<.../worker/mcp-permission.js>"] },
      "<client>-ops": { "type":"stdio", "command":"<node>", "args":["<.../worker/lthcs-ops.js>"] }
  }}
  ```
  The `runn` server is ALWAYS present; `<client>-ops` is added only when the cwd
  maps to a known client.
- The CLI is told `--permission-prompt-tool mcp__runn__ask_permission`. So every
  time Claude wants to Write/Edit/Bash, the CLI calls that MCP tool.
- `mcp-permission.js` is that MCP server. On each permission request it HTTP-calls
  back to Runn: `http://localhost:<RUNN_PORT>/ai-permission/<RUNN_PERMISSION_TOKEN>/<toolName>`
  (verify exact path/shape in `mcp-permission.js`). Runn decides `{allow, ...}`
  based on the card's `permission_mode`, and — in gated mode — **surfaces the
  request to the human in the browser and waits for approve/deny.**
- **You MUST port (a) the `/ai-permission/...` HTTP endpoint into V2's
  `server.js`, and (b) whatever UI affordance V1 uses to show the pending
  permission prompt and collect the human's approve/deny.** Study V1's
  server.js + frontend to see exactly how a pending permission is broadcast
  (likely a WebSocket event) and answered (likely a POST back). Replicate it.
  This is the single trickiest piece — read it carefully first.

### 4.4 Per-cwd lock
- `activeCwds` Map (`bridge.js` ~line 85). `claimCwd(cwd, holder)` throws
  `{code:'CWD_BUSY'}` if held; `releaseCwd(cwd)` on child exit, then
  `dispatchPendingForCwd` fires the next queued message (FIFO per cwd).
- On contention, V1's HTTP handler returns **202** `{queued:true}` and buffers
  the message in `pendingMessages` keyed by session.

### 4.5 Streaming back to the browser
- V1 does NOT pipe the child's stdout to the browser. Instead a **chokidar
  watcher on `~/.claude/projects/`** (server.js ~line 2108) fires on `.jsonl`
  changes and broadcasts `{type:'session.updated', session_id}` over `/ws`.
- The browser then GETs `/cards/:id/transcript`, which runs `parseTranscript`
  (server.js ~line 611) — it reads the session `.jsonl` and converts it to
  `[{role, text, at, ...}]` (assistant text, tool-use bubbles, etc.).

### 4.6 Status / timer / exit
- Spawn → card `doing` (timer starts; `doing_started_at` stamped).
- `handleAiExit(cardId, code, deps)` (`worker/queue.js` ~line 103): clean exit
  (code 0) and nothing queued → card → `review`; non-zero → `blocked`. Timer
  stops via `applyTimerTransition` (folds elapsed into `work_seconds`).
- **AI NEVER sets `done`** — `done` is a human-only transition (this is the whole
  point of the "✓ Done" button). On a clean turn the job lands in `review`
  (waiting on the human). `blocked` = waiting on something/someone other than the
  human.

---

## 5. V2 CURRENT STATE (what you're working with)

### 5.1 Present but UNWIRED
`runn-rebuild-dev/worker/` already contains, copied from V1 and **not imported by
the lean `server.js`**: `bridge.js` (identical to V1, takes a job-friendly
`location` arg), `queue.js` (card/parent-hierarchy specific — V2 jobs are flat,
so you likely write a small job-exit handler instead of reusing it wholesale),
`mcp-permission.js`, `lthcs-ops.js` + `lthcs-ops-config.js` + `lthcs-ops-tools/`,
`timer.js`, `cron.js`, and the migrate-* scripts.

`bridge.js` is cleanly decoupled — its public API is:
```
spawnSession({ title, notes, location, permissionToken, permissionMode,
               systemPromptAppend, onExit, holder, attachments })
sendMessage({ sessionId, text, location, permissionToken, permissionMode,
              systemPromptAppend, onExit, holder })
// plus DEFAULT_LOCATION, clientForCwd, whoHoldsCwd, enqueue/pending helpers
```
`location` = `{ type:'local', cwd }`. Confirm the exact exports and return
shape (how `session_id` comes back — promise vs. via an init callback) by reading
`bridge.js` end to end.

### 5.2 `worker/server.js` (V2, lean — ~14 KB)
Imports only `./store`, `./jobs`, `./invoices`. Routes:
`GET/POST /jobs`, `GET/PATCH/DELETE /jobs/:id`,
**`POST /jobs/:id/turn`** (currently just `jobs.appendTurn` — the stub you must
extend), `GET/PUT /jobs/:id/notes`, invoices routes, `GET /clients`,
`GET /clients/:id`, `GET/PUT /settings`, `/ws`. A `broadcast(msg)` helper +
chokidar watchers on the jobs/clients/invoices dirs already turn disk writes into
`job.added|changed|removed` (etc.) WS events. There is **no** `/ai-permission`
endpoint, **no** bridge import, and **no** `~/.claude/projects` session watcher.
The header comment notes the AI was deliberately stripped to "keep it lean" and
preserved on `main` + the `v1-cards` tag.

### 5.3 `worker/jobs.js` (V2 data layer — the JOB model)
A JOB is the whole unit (one long chat, the unit of work + conversation +
billing). Key API: `createJob`, `readJob`, `writeJob`, `patchJob` (patches
scalars AND runs `applyTimerTransition` on status change; sets `done_at` on
done), `setStatus`, `appendTurn({role,text,session_event?,at?})`, `listJobs`,
`readNotes`/`writeNotes` (companion `<id>.notes.md`), `deleteJob`, `JOBS_DIR`.
Job schema:
```
{ id, client_id, title, status, created_at, updated_at, due_at, done_at,
  doing_started_at, work_seconds, hours, turns:[{role,text,at,session_event?}],
  session_id, invoice_summary, invoice_id, invoice_line_id, archived }
```
`STATUSES = ['open','doing','review','done','invoiced','paid','blocked','hold']`,
`ROLES = ['user','ai']`. The work clock: time accrues only while `status==='doing'`;
`patchJob` stamps `doing_started_at` on entering `doing` and folds elapsed
seconds into `work_seconds` on leaving.

**The header comment makes the cwd decision explicit:** *"cwd is NOT stored on the
job — it is derived from the job's `client.workspace` at spawn time."*

### 5.4 Clients (live on the NUC, `RUNN_DATA/clients`)
Each client JSON has a `workspace` string. Confirmed values:
`EFEM→easy-fleet-endpoint-manager`, `EFITM→easy-fleet-it-manager`,
`LTHCS→lthcs` (id `cl_mpewz8hv_3680`, $150/h, billable), `NGS→ngs`, `RC→rc`,
`Test2Client→test2client`, `Runn→runn`, `Waz→waz`, `ZIS→zis`.
So **cwd = `/home/waz/projects/<client.workspace>`**. For a client-less
("Personal") job, fall back to `DEFAULT_LOCATION` (`~/runn-data`) — match V1.
(The dev-box `~/runn-rebuild-data` copy may have NO clients dir; the real clients
are on the NUC. If you test locally, seed a client with `workspace:"runn"`.)

### 5.5 Frontend (`frontend/index.html`, single-file app)
- It already POSTs user turns: around `sendMsg()` it does
  `postJson('/jobs/'+id+'/turn', { role:'user', text })`, then re-renders.
- It already opens `/ws` and re-renders on `job.added|changed`.
- There is a "thinking" UX concept: an **inline ops bubble** ("thinking bubble" —
  KEEP it) vs. a redundant `#chatThinking` pill. Render AI turns + a thinking
  state while `status==='doing'`.
- The mobile chat header is a 3-row grid and is already space-tight at ≤375px
  (pre-existing). Don't make it worse.

---

## 6. WHAT TO BUILD (the plan — follow V1)

Implement in this order; validate each step before the next.

**Step 1 — Run Claude on a user turn (`server.js`).**
- Import `bridge`. Add a cwd resolver: read the job's client, compute
  `/home/waz/projects/<workspace>`; fallback `~/runn-data` if no client.
- Extend `POST /jobs/:id/turn`: append the user turn (keep current behavior),
  then **if `role==='user'`** kick the engine:
  - no `session_id` → `bridge.spawnSession({ title: job.title || firstLine,
    notes: await jobs.readNotes(id), location:{type:'local',cwd}, permissionMode:
    <gated>, onExit:(code)=>handleJobExit(id,code), holder:'job:'+id })`;
    capture the returned `session_id`, persist it on the job.
  - has `session_id` → `bridge.sendMessage({ sessionId, text, location, onExit, holder })`.
  - On `CWD_BUSY` → return **202** `{queued:true}` and buffer (reuse bridge's
    pending/enqueue path).
  - Flip job → `doing` via `jobs.patchJob(id,{status:'doing'})` (starts the clock).
  - Return the job (201/202).

**Step 2 — Permission bridge (the gated model).**
- Port V1's `/ai-permission/<token>/<tool>` endpoint into V2 `server.js`.
- Wire `mcp-permission.js` env (`RUNN_PORT`, `RUNN_PERMISSION_TOKEN`) through the
  bridge spawn (bridge already passes these — confirm).
- Surface a **pending permission request to the browser** (WS event) and accept
  the human's **approve/deny** (a POST endpoint), exactly as V1 does. Port V1's
  UI affordance for this (study how V1's frontend renders + answers it).
- Default `permission_mode` = the V1 GATED mode (ask before write/Bash/Edit).
  Auto-allow read-only if V1 does. Do NOT add an auto-approve-everything mode.

**Step 3 — Stream replies back (live).**
- Add a chokidar watcher on `~/.claude/projects/` (scoped to the active session
  slugs if practical). On `.jsonl` change for a job's session, parse new turns
  (port V1's `parseTranscript`) and **append/merge AI turns into `job.turns[]`**,
  then `writeJob` so the existing jobs-dir watcher broadcasts `job.changed` and
  the UI updates live. (Decide: sync into `turns[]` — the V2 model stores turns
  inline — rather than V1's separate transcript endpoint. Avoid duplicating turns
  on repeated writes; dedupe by content/index.)

**Step 4 — Exit / status / timer.**
- `handleJobExit(jobId, code)`: clean (0) → `jobs.patchJob(jobId,{status:'review'})`;
  non-zero → `{status:'blocked'}`. `patchJob` stops the clock automatically.
  AI never sets `done`. Then dispatch any queued turn for that cwd.

**Step 5 — Frontend polish.**
- Render AI turns; show the inline thinking bubble while `doing`; render the
  permission prompt + approve/deny. Keep the existing send flow.

---

## 7. TESTING (do this before deploying — it spawns REAL Claude)

1. **Local first, on a SAFE workspace.** Run the worker in this container:
   `cd /home/waz/projects/runn-rebuild-dev && PORT=18080 HOST=127.0.0.1
   RUNN_DATA=/tmp/runn-ai-test node worker/server.js`. Seed `/tmp/runn-ai-test`
   with: `clients/cl_runn.json` `{id:"cl_runn",name:"Runn",workspace:"runn",
   non_billable:true}` and one `open` job with `client_id:"cl_runn"`. So the AI's
   cwd is `/home/waz/projects/runn` — wait: that's V1's tree. **Use a throwaway
   workspace instead** (e.g. create `/home/waz/projects/ai-sbx` and point the
   test client's `workspace:"ai-sbx"`), so the test AI can't touch V1 or a client
   tree. Do NOT first-test against `lthcs`/`ngs`/`zis`/`rc` (real client infra).
2. Use the **Preview MCP** (`.claude/launch.json` config → `preview_start`,
   `preview_resize` mobile, `preview_click`, `preview_eval`) to drive the UI in a
   browser: open the job, send a message, confirm: status flips to `doing`, a
   real `claude` child spawns (check `ps`/the session `.jsonl` under
   `~/.claude/projects/`), a **permission prompt appears and is answerable**,
   approving lets Claude proceed, replies stream into the chat, and on completion
   the job lands in `review` with the work-clock advanced. Verify the per-cwd
   lock: a second concurrent send to a job in the same cwd should queue (202).
3. **Clean up** the throwaway data dir, sandbox workspace, and any
   `.claude/launch.json` test config when done.

---

## 8. DEPLOY (only after local verification passes)

1. Commit on branch `rebuild` (Co-Authored-By trailer). Push:
   `git push origin rebuild` (run with `dangerouslyDisableSandbox: true`). This
   is the "backup to GitHub" the user expects.
2. Deploy to the NUC (updates the public site, since it proxies to `:17778`):
   ```
   ssh -i ~/.ssh/id_rsa -o BatchMode=yes -o ConnectTimeout=10 waz@192.168.50.62 \
     'cd /home/waz/runn-rebuild && git fetch origin rebuild && \
      git reset --hard origin/rebuild && \
      sudo systemctl restart runn-rebuild.service && sleep 1 && \
      systemctl is-active runn-rebuild.service && git log --oneline -1'
   ```
   (run with `dangerouslyDisableSandbox: true`).
3. Confirm live: the NUC has the real clients + the logged-in `claude` CLI, so AI
   actually runs there. Sanity-check `https://runn.robotsand.co` serves the new
   build, but be cautious actually triggering AI against a live client workspace —
   coordinate with the user before running it against a real client tree.

---

## 9. DEFINITION OF DONE

A user opens a job in V2 (LAN `:17778` or `https://runn.robotsand.co`), types a
message, and:
- a `claude` process runs in that job's client workspace (`/home/waz/projects/<workspace>`);
- it **asks the user before every write/Edit/Bash**, the prompt shows in the UI,
  and approve/deny works (gated, V1-faithful);
- its replies stream into the job's chat live (via the session `.jsonl` watcher →
  `job.changed`);
- the job goes `open/…` → `doing` (clock runs) → `review` on a clean turn, or
  `blocked` on a crash; AI never sets `done`;
- follow-up messages resume the same session (`--resume`); a second writer in the
  same cwd queues instead of running in parallel;
- it's committed + pushed to `origin/rebuild` and deployed to the NUC.

---

## 10. POINTERS / MEMORY (context that won't be obvious from code)

- The auto-memory store is `/home/waz/.claude/projects/-home-waz-projects-runn/memory/`
  with an index `MEMORY.md`. Relevant entries:
  `project_mcp_only_access` (the non-negotiable MCP-only rule),
  `project_no_parallel_ai` (per-cwd lock),
  `runn_spawn_env_node_only` (Node-only spawn env),
  `project_runn_mission`, `project_thinking_indicators`,
  `project_nuc_native_deploy`, `project_public_domain_stale_deploy`
  (the public site now proxies to the NUC — repoint is DONE and TLS works),
  `git_workflow_main` / `feedback_git_github_default` (commit+push = "saved"),
  `feedback_terse_chat_mode`, `feedback_no_section_symbol`.
- `/home/waz/projects/CLAUDE.md` is the shared client-access primer (SSH, the
  clients lthcs/zis/rc/ngs, safety).
- Just-shipped (already live): a mobile "✓ Done" button in the job header
  (commit `cfc642f` on `rebuild`) — that's the human-only `done` transition.

When you finish, report tightly (the user is terse): what works, how you tested
it in the browser, and that it's pushed + deployed. Ask at most one question if
genuinely blocked.
