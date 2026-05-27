# Client-Ops MCP Boundary — Design / Spec

**Status:** design only. No MCP server code exists yet. This document specifies
the approach and records the alternatives considered.

**Audience:** the Runn operator (solo). Runn wraps the Claude Code CLI and is
used to do billable remote-administration work for several clients (lthcs, zis,
ngs) plus the operator's own org (rc). Client work happens by SSH/WireGuard from
inside the Runn worker container.

---

## 1. Purpose & the two fears

When an autonomous-ish AI agent (Claude, driven by Runn) touches client
infrastructure, there are **two distinct risks**. They are routinely conflated,
but they have different shapes and different mitigations. Treating them as one
problem is the main mistake this document exists to avoid.

### Fear 1 — Data leakage
Client PII reaching Anthropic's API and logs: IP addresses, internal hostnames,
SSH usernames, credentials, person/site names, file paths. Runn does **not** call
the Anthropic API directly — it spawns the globally-installed
`@anthropic-ai/claude-code` CLI (see `Dockerfile`), and that CLI is what talks to
the cloud. So anything that ends up in the model's context window — prompts, tool
inputs, tool *outputs* (command stdout!), and the model's own reasoning — is sent
off-box. A `zfs list` whose output contains a dataset name like `redset2/lthcs_*`
leaks the moment the model reads it.

### Fear 2 — Action / liability risk
An autonomous agent SSHing into a client's **production** system and *changing
something*. This is the "getting sued" worry: a destructive command, a service
restart at the wrong moment, a config edit that takes a clinic's database offline.

**Crucial point: these are different problems and redaction does nothing for Fear
2.** You can perfectly scrub every IP from the transcript and still let the model
run `zfs destroy` on a production pool. Conversely you can lock down every
destructive action and still leak the client's entire host inventory into a log.
Any honest solution has to address both axes explicitly. Most of this document is
about a single mechanism — a curated MCP boundary — that happens to attack both at
once, plus the action-risk controls Runn already has or should add.

---

## 2. Centerpiece — the curated `client-ops` MCP boundary

The key insight: for **operational** secrets (the IPs/creds/hostnames you need to
*do the work*, as opposed to PII that appears in free-text narrative), the winning
move is not "let the secret reach the model and then scrub it." It is **"never let
the secret enter the model's context in the first place."** This is *redaction by
design* and it is fully deterministic — there is no classifier to be wrong.

### How it works
Instead of giving the model a raw shell and the client's `CLAUDE.md` full of real
IPs, you expose each client task as a small set of **curated MCP tools**. A
**local** MCP server — running inside the Runn worker container, never off-box —
holds the real connection details and resolves abstract arguments to concrete
hosts itself.

```
  Claude (cloud)                Local client-ops MCP server         Client host
  ─────────────                 ────────────────────────────       ───────────
  calls tool:                   resolves "A" -> <LTHCS_HOST_A>
  zfs_status(site="A")  ──────▶ runs: ssh ... user@<real-ip>  ──────▶ zfs list
                                       'zfs list -t snapshot'
                                redacts/summarises output  ◀───────── (raw output)
  receives:           ◀──────── { pool: "primary", ... }
  { pool: "primary", lag: ... }
```

The model sees `site="A"` and a structured, sanitised result. It never sees
`<LTHCS_HOST_A>`, the SSH username, the pool path, or the receiver IP. The mapping
`A -> <LTHCS_HOST_A>` lives only in the local server's config, on-box.

> The placeholder discipline used throughout *this very document* —
> `<LTHCS_HOST_A>`, `<LTHCS_RECEIVER>` instead of real values — is the same idea
> applied to prose. If a design doc about not leaking PII leaked PII, it would have
> failed its own thesis.

### Why this addresses BOTH fears at once
- **Fear 1 (leakage):** the secret is resolved server-side and is never in a
  prompt or a tool result the model receives. The boundary is deterministic code,
  not a probabilistic redactor, so there is no first-sighting leak window and
  nothing to mis-classify. Tool *outputs* are shaped by the server before they
  return, so command stdout can't smuggle PII back into context.
- **Fear 2 (action/liability):** the tool menu *is* the action surface. If there
  is no `zfs_destroy` tool, the model cannot invoke one — no prompt-injection,
  jailbreak, or hallucinated command can reach a capability that was never
  exposed. Curation shrinks what's possible to exactly the verbs you chose, with
  read-only as the default tier.

### The tradeoff (state it honestly)
This only helps **to the degree you give up raw shell/SSH in favour of the curated
menu.** A tool for everything is just a shell with extra steps. The real tension is
**flexibility vs control**: the curated boundary is safe precisely because it is
narrow, and narrow means that genuinely novel, unplanned work either needs a new
tool authored first, or falls back to the raw-SSH path (which then re-incurs both
fears and must go through the existing approval flow). The design choice is to make
the common, repeated client operations into tools, and accept that exploratory
one-offs are the explicit, human-gated exception — not the default.

---

## 3. Worked example — lthcs (ZFS replication)

lthcs is the richest source of concrete operations: an hourly `zfs send -w -I` to
a remote receiver, a Windows VM running a clinical PMS on Firebird, and scoped
passwordless sudo on each box. (All host/IP/credential specifics live in
`/home/waz/projects/lthcs/CLAUDE.md`; they are deliberately **not** reproduced
here — placeholders below.) Sites/hosts referenced abstractly:

- `<LTHCS_HOST_A>` — primary sender host.
- `<LTHCS_HOST_B>` — second sender host (reachable directly, or hop via A).
- `<LTHCS_RECEIVER>` — receive/storage host, pool `<RECV_POOL>`.
- `<LTHCS_WINVM>` — the Windows guest (clinical PMS on Firebird).

### Operation classification

**READ-ONLY (safe to expose with read-only default; no approval needed, still
audited):**
- `zfs list` / list snapshots on a site — dataset & snapshot inventory.
- Replication status: latest common snapshot on sender vs receiver, send lag /
  backlog (the "send base" health that the stuck-send spiral is about).
- `zpool status <pool>` — pool health, scrub/resilver/degraded state.
- Receiver free space / dataset sizes.
- VM liveness probes: `virsh domstate <LTHCS_WINVM>`, TCP port reachability of the
  Firebird service (read-only — no DB writes).
- Read-only DB health check (e.g. the `gstat -h` style header read on the
  production `.fdb`) — reports clean/flagged without mutating.

**MUTATING — ALLOWED BUT REQUIRES APPROVAL (each call routed through the existing
permission prompt; snapshot-before-mutate where applicable):**
- Create an on-demand ZFS snapshot before any change (cheap insurance — see §5).
- Kick / re-fire a replication send for a dataset.
- **Kill a stuck send cleanly** — the documented correct remedy for the
  stuck-send spiral (discard the partial; the receiver stays at its real latest;
  the orchestrator recomputes a correct base next fire). This is mutating-ish but
  recoverable; gate it behind approval.
- Restart a defined service (e.g. the Firebird service, a Node-RED executor).
- Send a recovery keystroke to a stuck VM at WinRE (`virsh send-key ... ENTER`),
  capture a screenshot to diagnose (`virsh screenshot`).
- Controlled `virsh` lifecycle on the VM (start; reboot only with approval —
  note the VM has its own intentional nightly reboot that must be left alone).

**EXCLUDED — NEVER A TOOL (no signature exists; reachable only via the explicit
raw-SSH fallback, never the curated menu):**
- `zfs destroy` of any kind (datasets or snapshots) — the single most dangerous
  verb in this stack; deletion is not reversible by a snapshot.
- `zfs rollback -R` on the receiver — this is literally the action at the heart of
  the stuck-send spiral; automating it is how the incident perpetuated itself.
- `zpool destroy` / pool-level teardown.
- Raw arbitrary shell / arbitrary `sudo` — the whole point is that the menu is the
  surface; an "exec anything" tool would dissolve the boundary.
- Direct writes to the production clinical DB.

### Example tool signatures (illustrative — placeholders for sites)

```jsonc
// READ-ONLY tier — default, no approval
{
  "name": "zfs_replication_status",
  "description": "Latest common snapshot, send lag and pool health for a site.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "site": { "enum": ["A", "B", "RECEIVER"] },   // resolved server-side
      "dataset": { "type": "string" }               // logical name, not full path
    },
    "required": ["site"]
  }
}

// MUTATING tier — every call goes through the approval prompt + auto-snapshots first
{
  "name": "restart_service",
  "description": "Restart a known, named service on a site. Approval required.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "site":    { "enum": ["A", "B", "WINVM"] },
      "service": { "enum": ["firebird", "node_red_executor"] },  // closed set
      "reason":  { "type": "string" }                            // for the audit trail
    },
    "required": ["site", "service", "reason"]
  }
}
```

Note both signatures: arguments are **closed enums and logical names**, not
free-form hostnames or commands. The model literally cannot express
"`<LTHCS_HOST_A>`" because the only thing it can say is `"A"`. That closure is what
makes the boundary deterministic on both the leakage and the action axis.

---

## 4. Integration with Runn's existing machinery

The good news is that Runn already has the load-bearing pieces; the `client-ops`
server slots in beside them rather than replacing anything.

- **Spawn path (`worker/bridge.js`):** Runn spawns the CLI with
  `--mcp-config <path>` and `--permission-prompt-tool mcp__runn__ask_permission`
  (see `spawnSession` / `sendMessage`). Today `ensureMcpConfig()` writes a config
  with a single server (`runn`, the permission tool). The `client-ops` server is
  **a second entry in that same `mcpServers` map** — a sibling stdio Node process
  launched per session. No new transport, no base-URL override, no proxy needed
  for the operational-secret case; this is the cleanest hook point.

- **Approval flow (`worker/mcp-permission.js`):** this existing stdio MCP server
  exposes `ask_permission`, which the CLI calls before any Write/Edit/Bash. It
  forwards to the worker over HTTP (`POST /permissions/request`), which parks the
  request, shows Allow/Deny in the chat UI, and replies. **Every mutating
  `client-ops` tool call inherits this gate for free** — the CLI routes *all* tool
  permission checks through the configured prompt tool, so a mutation surfaces the
  same Allow/Deny card the operator already knows. We do **not** reinvent approval;
  we reuse it. (The server can additionally hard-gate: read-only tools return
  immediately; mutating tools can decline to act until they observe an allow.)

- **Where the server runs:** in the **Runn worker container**, the same place the
  real SSH keys (`~/.ssh`, read-only mount) and WireGuard-reachable routes already
  live. The secret resolution (`"A"` -> `<LTHCS_HOST_A>`) therefore happens exactly
  where the credentials already are, and never crosses the container boundary
  toward the cloud. It is launched per-session over stdio (like the permission
  server) so it shares the session's lifecycle.

- **Single-writer lock:** `bridge.js` enforces one `claude` per cwd
  (`claimCwd`/`releaseCwd`), and Runn's concurrency rule is that the lock is
  per-cwd, not global. The `client-ops` server is **stateless request/response over
  stdio**, launched and torn down with each session, so it does not introduce a
  long-running shared writer of its own and does not need its own lock — it lives
  inside the session that already holds the cwd. (If a future version wanted a
  persistent daemon — e.g. to hold an SSH ControlMaster — that would need its own
  concurrency story; out of scope here.)

- **Audit trail:** Claude Code writes the full session transcript as `.jsonl`
  under `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` (see
  `sessionPathFor` / `cwdToSlug` in `bridge.js`). Every tool call, its arguments,
  the approval decision, and the (sanitised) result are captured there. That
  transcript is the provenance record — see §5.

---

## 5. Reversibility and audit / provenance

**Reversibility (ZFS makes this nearly free):** lthcs is a ZFS shop, and ZFS
snapshots are instant and cheap. The mutating tier should **snapshot before it
mutates** — take an on-demand snapshot of the affected dataset immediately before
a change. This turns "an AI broke production" into "roll back to the
pre-change snapshot." A reversible mistake is an incident; an irreversible one is a
liability. This is also exactly why `zfs destroy` and `zfs rollback -R` are in the
excluded tier: they are the operations a snapshot *cannot* save you from.

**Audit / provenance:** Runn already keeps complete `.jsonl` session transcripts.
Combined with the curated boundary (where every action is a named tool call with a
required `reason`) and the per-mutation approval record, this gives a defensible
chain: *what was proposed, who approved it, what exactly ran, what it returned.*
Provenance protects the operator — when a client asks "what did your tooling do on
our box at 14:00," there is a precise, timestamped answer rather than an opaque
shell history.

**Plan-then-apply / separate diagnosis from mutation:** prefer a two-step shape —
the model first proposes the exact command(s) or diff (diagnosis, read-only), the
human reviews, *then* a separate apply step executes. This keeps "figure out
what's wrong" cleanly distinct from "change the system," and means the approval
prompt is reviewing a concrete, already-formed action rather than a vague intent.

Rough ordering of the action-risk controls by impact:
1. **Curated tools + read-only by default** — the capability simply isn't there.
2. **Plan-then-apply** — diagnosis is separated from mutation; the human reviews
   the exact change before it runs.
3. **Human approval on every mutation** — already enforced via
   `mcp-permission.js`.
4. **Reversibility** — snapshot-before-mutate (cheap on ZFS).
5. **Audit trail** — `.jsonl` transcripts as provenance.

---

## 6. Alternatives considered

Two redaction architectures were weighed before settling on the MCP-by-design
boundary for operational secrets. Both are about Fear 1 only and neither addresses
Fear 2.

### Redaction Solution A — "the terrain pipeline" (offline dictionary + deterministic proxy)
A batch/offline local AI periodically discovers new PII and hydrates Microsoft
Presidio deny-list dictionaries; **additions go to a quarantine for human review,
not an auto-merge.** At request time, enforcement is **deterministic**: regex +
dictionary + Presidio NER, with reversible tokens, implemented as a local proxy
the CLI points at via `ANTHROPIC_BASE_URL`.
- **Strengths:** deterministic and auditable (the policy is a flat-file
  dictionary you can read), and the AI is off the hot request path.
- **Weaknesses:** the dictionary only protects from the *second* sighting of a
  given value onward — there is an unavoidable **first-sighting leak window**;
  Presidio's live NER is the only real-time net for novel values and it is
  imperfect; and the dictionary + reversal-map becomes a concentrated PII target
  that itself must be protected.

### Redaction Solution B — local AI as live broker
A local model is the front door: Runn talks only to it; it redacts live and
forwards to cloud Claude, rehydrating replies and tool calls; it may even triage
easy tasks itself.
- **Strengths:** can catch novel PII on first contact, and can keep some traffic
  fully local.
- **Weaknesses:** it puts a **non-deterministic gate on the hot path of every
  message** — a cardinal sin for a security control; local models are far weaker
  than cloud Claude (so it both over- and under-redacts); lossy redacted context
  degrades answer quality; it costs two inferences plus latency per turn; it must
  proxy the *entire* agent protocol (tool calls, tool results, streaming,
  permissions); and the policy is **unauditable** because it lives in model
  weights.

### Why MCP-by-design wins for operational secrets
For the IPs/creds/hostnames needed to *do the work*, MCP beats both A and B because
it **prevents** the secret from entering context rather than **scrubbing** it
afterward. There is no leak window (A's weakness) and no non-deterministic gate on
the hot path (B's weakness). It is the only one of the three that also shrinks the
**action** surface, so it's the only one that touches Fear 2 at all.

**Complementarity (not either/or):** the MCP boundary covers *structured*
operational secrets — the things that fit a tool signature. It does **not** cover
free-text/narrative PII: a client's name in a problem description, a person's name
the operator types into a chat message, addresses in a pasted log. For that
residual surface, an **A-style deterministic text-redaction proxy is still the
right complement** — applied to the free-text channel, where its first-sighting
window is a tolerable risk and its determinism/auditability are exactly what you
want. The two compose: MCP for structured ops secrets, A-style redaction for prose.

---

## 7. Non-engineering backstop

Engineering controls reduce the probability and blast radius of a bad action, but
they are not the whole liability story. The operator should also have, as a
**non-engineering** backstop: written **authorization** to administer each
client's systems; **contracts** with an explicit **limitation-of-liability**
clause; **errors-and-omissions (E&O) insurance**; and **client consent to
AI-assisted administration** specifically (not just human admin). These are named
here only so they aren't forgotten — *this is out of scope for the engineering
design and is not legal advice; consult a qualified professional.*

---

## 8. Open questions / next steps

1. **Tool catalogue scope.** Which lthcs operations graduate to tools first?
   Suggest starting with the read-only tier (status/health) since it's pure upside
   — leak reduction with zero action risk — then the highest-frequency mutations
   (kick send, kill stuck send, restart service).
2. **Site/secret config format.** Where does the `"A" -> <LTHCS_HOST_A>` map live,
   and how is it kept out of the model's reach but easy for the operator to edit?
   (A local-only file the server reads, mirroring how `mcp-permission.js` reads its
   token from env.)
3. **Read-only vs mutating gating inside the server.** The CLI's permission prompt
   gates all tool calls uniformly; should the server *also* self-enforce a
   read-only default (refuse mutations absent an explicit signal) as defence in
   depth?
4. **Output sanitisation depth.** How aggressively should tool results be shaped?
   A `zfs list` summarised to `{pool, lag, healthy}` leaks nothing; returning raw
   stdout risks re-introducing PII. Define the per-tool result schema deliberately.
5. **Raw-SSH fallback policy.** When a task genuinely needs an unscripted command,
   what's the explicit, human-gated escape hatch — and how is *that* logged so the
   provenance chain stays intact?
6. **Snapshot-before-mutate ergonomics.** Auto-snapshot per mutation vs one
   snapshot per session; naming/retention so these insurance snapshots don't
   themselves become send-base noise.
7. **Per-client servers vs one server.** One `client-ops` server with a `client`
   argument, or one server per client (`lthcs-ops`, `zis-ops`, …) selected by the
   card's cwd/context? Per-client keeps blast radius and config scoped to the
   client whose tree the session is in.
8. **Persistent daemon question.** If an SSH ControlMaster / connection reuse is
   ever wanted, the stateless per-session model changes and needs its own
   concurrency story against the per-cwd lock.
