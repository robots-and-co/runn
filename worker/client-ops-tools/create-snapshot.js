'use strict';

// MUTATING client-ops tool: create_snapshot({ site, dataset, reason })
//
// First tool in the mutating tier (CLIENT_OPS_MCP_DESIGN.md §3, §5). Every
// call is gated by the CLI's `--permission-prompt-tool mcp__runn__ask_permission`
// — Claude calls that *before* this handler runs, so a denied call never
// reaches us. We do not reinvent the gate (§4).
//
// The tool is intentionally a thin wrapper around the shared snapshot helper
// in ./_snapshot.js. Future mutating tools (kick send, restart_service,
// kill_stuck_send, …) will call the same helper as a pre-hook before they
// touch state, so the helper — not this tool — is the reusable surface.
//
// `reason` is required and recorded in the worker stderr audit line. It does
// NOT appear in the snapshot tag (length / charset / injection concerns) — the
// tag is purely `runn-pre-mutate-<epoch>`. Pairing tag → reason after the fact
// is done via the audit trail (worker stderr + Claude's .jsonl transcript).
//
// Result schema (success):
//   { ok: true, tag: "runn-pre-mutate-<epoch>", created: ISO-8601 UTC }
//
// Errors:
//   { error: "unknown_site" | "invalid_dataset" | "invalid_reason" |
//            "snapshot_create_failed" }

const { createPreMutateSnapshot } = require('./_snapshot');

const NAME = 'create_snapshot';
const CATEGORY = 'mutating';
const DESCRIPTION =
  'Take an on-demand ZFS snapshot of a dataset on a site, as cheap ' +
  'insurance before any change. Approval required. Returns the snapshot ' +
  'tag (a `runn-pre-mutate-<epoch>` handle); no pool, dataset, or host ' +
  'names are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:    { enum: siteNames },
      dataset: { type: 'string' },
      reason:  { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['site', 'dataset', 'reason'],
    additionalProperties: false,
  };
}

function sanitiseReason(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.length || trimmed.length > 500) return null;
  return trimmed;
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  // Audit line — stays on box; site label is abstract ("A", "RECEIVER"…) and
  // the dataset string is the same one the model already sent, so this log
  // line introduces no new leak surface. Reason is the operator-readable
  // record of *why* a snapshot was taken.
  process.stderr.write(
    `client-ops: create_snapshot site=${JSON.stringify(siteLabel)} ` +
    `reason=${JSON.stringify(reason)}\n`
  );

  const snap = await createPreMutateSnapshot(site, args && args.dataset);
  if (!snap.ok) return { error: snap.error };
  return { ok: true, tag: snap.tag, created: snap.created };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { sanitiseReason },
};
