'use strict';

// Registry of curated client-ops tools. Each entry is one MCP tool that the
// boundary server (worker/client-ops.js) exposes. Adding a tool here is the
// only change needed to surface it on tools/list — see task 04 for the next
// batch of read-only probes.
//
// Each module must export:
//   - NAME           : the MCP tool name (must be a valid identifier)
//   - DESCRIPTION    : one-line, model-visible description
//   - inputSchema(siteNames) -> JSON Schema (siteNames is the configured enum)
//   - handler(args, ctx) -> structured result (no raw stdout/stderr)
//
// `ctx` always contains `{ sites }` (the resolved site/secret config map).

const zfsReplicationStatus = require('./zfs-replication-status');

const TOOLS = [zfsReplicationStatus];

function listForMcp(siteNames) {
  return TOOLS.map(t => ({
    name: t.NAME,
    description: t.DESCRIPTION,
    inputSchema: t.inputSchema(siteNames),
  }));
}

function findByName(name) {
  return TOOLS.find(t => t.NAME === name) || null;
}

module.exports = { TOOLS, listForMcp, findByName };
