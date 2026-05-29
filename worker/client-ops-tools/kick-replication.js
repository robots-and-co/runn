'use strict';

// MUTATING client-ops tool: kick_replication({ site, dataset, reason })
//
// Re-fires a ZFS replication send for a dataset on a site. Approval is
// inherited from the CLI's `--permission-prompt-tool mcp__runn__ask_permission`
// gate (CLIENT_OPS_MCP_DESIGN.md §4) — a denied call never reaches this
// handler. The mutating-tier audit line on stderr (see worker/client-ops.js)
// is added on top as belt-and-braces.
//
// Two-step shape, in order:
//   1. Pre-mutate snapshot via the shared helper in ./_snapshot.js. This is
//      the "snapshot-before-mutate" insurance §5 calls for — a kicked send
//      that goes wrong becomes "roll back to the snapshot," not an incident.
//   2. Run the operator-supplied kick command on the sender via SSH.
//
// The kick command itself comes from the per-site config field
// `replication_kick_cmd` — a deliberate boundary choice. Different sites
// kick differently (direct `zfs send | ssh recv zfs recv`, an MQTT publish
// to the brain, a Node-RED webhook, …) and that policy belongs with the
// operator, not in the MCP server. The result the model sees reports only
// outcome + snapshot tag; the resolved command text never leaves the box.
//
// `{dataset}` in the template is replaced with the sanitised dataset string;
// if the template has no `{dataset}` placeholder, the dataset is appended as
// a positional argument (the common `kick.sh <ds>` shape).
//
// Result schema (success):
//   { ok: true, snapshot_tag: "runn-pre-mutate-<epoch>", fired: true }
//
// Errors:
//   { error: "unknown_site" | "invalid_dataset" | "invalid_reason" |
//            "site_not_configured_for_kick" | "snapshot_create_failed" |
//            "kick_failed" }
// On kick_failed we include the snapshot_tag so the operator can roll back.

const { sshBaseArgs, run } = require('./_ssh');
const { createPreMutateSnapshot } = require('./_snapshot');

const NAME = 'kick_replication';
const CATEGORY = 'mutating';
const DESCRIPTION =
  'Re-fire a ZFS replication send for a dataset on a site (the sender). ' +
  'Takes a pre-mutate ZFS snapshot first as cheap insurance, then runs the ' +
  'operator-configured kick command on the sender. Approval required. ' +
  'No hostnames, paths or pool names are returned — only outcome + the ' +
  'pre-mutate snapshot tag.';

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

// Same charset the other tools enforce on dataset arguments.
const DATASET_RE = /^[A-Za-z0-9._/\-]+$/;
function sanitiseDataset(s) {
  if (typeof s !== 'string' || !s.length || s.length > 255) return null;
  if (!DATASET_RE.test(s)) return null;
  return s;
}

function sanitiseReason(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.length || trimmed.length > 500) return null;
  return trimmed;
}

// Build the remote command. Operator template wins; otherwise append dataset.
// `dataset` has already been sanitised against the strict charset above, so
// no remote-shell escaping is required.
function buildKickCmd(template, dataset) {
  return template.includes('{dataset}')
    ? template.replace(/\{dataset\}/g, dataset)
    : `${template} ${dataset}`;
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const dataset = sanitiseDataset(args && args.dataset);
  if (!dataset) return { error: 'invalid_dataset' };

  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  if (!site.replication_kick_cmd) {
    return { error: 'site_not_configured_for_kick' };
  }

  // Audit line — site label is abstract and the dataset is already known to
  // the model, so this log line introduces no new leak surface. Reason is
  // the operator-readable record of *why* the kick was fired.
  process.stderr.write(
    `client-ops: kick_replication site=${JSON.stringify(siteLabel)} ` +
    `reason=${JSON.stringify(reason)}\n`
  );

  const snap = await createPreMutateSnapshot(site, dataset);
  if (!snap.ok) return { error: snap.error === 'invalid_dataset' ? 'invalid_dataset' : 'snapshot_create_failed' };

  const remoteCmd = buildKickCmd(site.replication_kick_cmd, dataset);
  const res = await run('ssh', [...sshBaseArgs(site), remoteCmd], { timeoutMs: 120000 });
  if (!res.ok) return { error: 'kick_failed', snapshot_tag: snap.tag };

  return { ok: true, snapshot_tag: snap.tag, fired: true };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { sanitiseDataset, sanitiseReason, buildKickCmd },
};
