'use strict';

// Registry of curated client-ops tools. Each entry is one MCP tool that the
// boundary server (worker/client-ops.js) exposes. Adding a tool here is the
// only change needed to surface it on tools/list.
//
// Each module must export:
//   - NAME           : the MCP tool name (must be a valid identifier)
//   - CATEGORY       : 'read-only' | 'mutating'  (see §3 of the design doc)
//   - DESCRIPTION    : one-line, model-visible description
//   - inputSchema(siteNames) -> JSON Schema (siteNames is the configured enum)
//   - handler(args, ctx) -> structured result (no raw stdout/stderr)
//
// Optional:
//   - isEnabled() -> boolean. When defined and false, the tool is filtered
//     out of BOTH tools/list and findByName, i.e. it stops existing on the
//     wire. Used by the raw_ssh_exec escape hatch (§8.5) to stay invisible
//     unless an env flag opts the operator in.
//
// `ctx` always contains `{ sites }` (the resolved site/secret config map).
//
// `CATEGORY` is server-side metadata only — it is NOT shown to the model.
// Its role is to (a) annotate intent in source, (b) drive the stderr audit
// line on every mutating call, and (c) provide a hook for future defence-in-
// depth (design doc §8.3 — open question on whether the server should
// self-enforce a read-only default beyond the CLI's permission prompt).
// Approval for mutating tools is inherited from the CLI's
// `--permission-prompt-tool mcp__runn__ask_permission` gate; we do not
// reinvent it here (§4).

const zfsReplicationStatus = require('./zfs-replication-status');
const zpoolStatus          = require('./zpool-status');
const listSnapshots        = require('./list-snapshots');
const receiverFreeSpace    = require('./receiver-free-space');
const vmLiveness           = require('./vm-liveness');
const dbHealthCheck        = require('./db-health-check');
const createSnapshot       = require('./create-snapshot');
const kickReplication      = require('./kick-replication');
const killStuckSend        = require('./kill-stuck-send');
const restartService       = require('./restart-service');
const rawSshExec           = require('./raw-ssh-exec');

const TOOLS = [
  zfsReplicationStatus,
  zpoolStatus,
  listSnapshots,
  receiverFreeSpace,
  vmLiveness,
  dbHealthCheck,
  createSnapshot,
  kickReplication,
  killStuckSend,
  restartService,
  rawSshExec,
];

const VALID_CATEGORIES = new Set(['read-only', 'mutating']);

// Loud failure at require-time if a tool forgets to declare CATEGORY or
// declares an unknown one. That way a misregistered tool never silently
// lands in the registry — the server fails to start instead.
for (const t of TOOLS) {
  if (!VALID_CATEGORIES.has(t.CATEGORY)) {
    throw new Error(
      `client-ops: tool "${t.NAME}" has missing/invalid CATEGORY ` +
      `(got ${JSON.stringify(t.CATEGORY)}; expected one of ${[...VALID_CATEGORIES].join(', ')})`
    );
  }
}

// Tools that opt out of registration via `isEnabled()` are filtered here so
// they are simultaneously invisible to tools/list AND unreachable via
// tools/call. A tool without an isEnabled hook is always enabled.
function isToolEnabled(t) {
  return typeof t.isEnabled !== 'function' || t.isEnabled();
}

function listForMcp(siteNames) {
  return TOOLS.filter(isToolEnabled).map(t => ({
    name: t.NAME,
    description: t.DESCRIPTION,
    inputSchema: t.inputSchema(siteNames),
  }));
}

function findByName(name) {
  const t = TOOLS.find(x => x.NAME === name);
  if (!t) return null;
  if (!isToolEnabled(t)) return null;
  return t;
}

module.exports = { TOOLS, listForMcp, findByName, isToolEnabled };
