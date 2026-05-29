'use strict';

// READ-ONLY lthcs-ops tool: kick_replication_plan({ site, dataset, reason })
//
// Plan-then-apply counterpart of kick_replication (CLIENT_OPS_MCP_DESIGN.md §5).
// Validates the same inputs, freezes the pre-mutate snapshot tag, builds a
// plan envelope describing the two-step "snapshot then kick" sequence, and
// registers it with the worker. Does NOT execute.
//
// Note on the kick command: the raw `replication_kick_cmd` text is a
// site-config secret (operator-supplied path / script), so the model view of
// the plan only describes it abstractly ("run the configured kick command
// for site A with dataset <ds>"). The executor at apply time uses the raw
// text from the live site config — the plan envelope does not carry it. That
// keeps the approval-card payload at parity with what the model would see
// calling kick_replication directly: no widening of the leak surface.
//
// Errors:
//   { error: "unknown_site" | "invalid_dataset" | "invalid_reason" |
//            "site_not_configured_for_kick" }

const { sanitiseDataset, buildTag } = require('./_snapshot')._internals;
const kick = require('./kick-replication');
const plans = require('./_plans');

const NAME = 'kick_replication_plan';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Propose (without executing) re-firing a ZFS replication send for a ' +
  'dataset on a site. Returns a plan body: a pre-mutate `zfs snapshot` ' +
  'with frozen tag, then the configured kick command for that site with ' +
  'the dataset substituted in. The raw kick command text is a site config ' +
  'secret and is summarised abstractly. Use apply_plan(plan_id, reason) to ' +
  'execute; approval shows this plan body.';

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

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const dataset = sanitiseDataset(args && args.dataset);
  if (!dataset) return { error: 'invalid_dataset' };

  const reason = kick._internals.sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  if (!site.replication_kick_cmd) {
    return { error: 'site_not_configured_for_kick' };
  }

  const tag = buildTag();
  const snapshotCmd = `zfs snapshot ${dataset}@${tag}`;

  const envelope = plans.makeEnvelope({
    tool: 'kick_replication',
    site_label: siteLabel,
    reason,
    affects: [`dataset:${dataset}`, `replication:${siteLabel}/${dataset}`],
    steps_model_view: [
      {
        kind: 'ssh_exec',
        site_label: siteLabel,
        remote_command: snapshotCmd,
        timeout_ms: 30000,
        label: 'take pre-mutate snapshot',
      },
      {
        kind: 'ssh_exec_configured',
        site_label: siteLabel,
        // Abstract description; the literal site.replication_kick_cmd is NOT
        // included — it's a site-config secret. Apply-time executor reads it
        // from live config.
        remote_command_abstract:
          `<configured kick command for site ${siteLabel}> ${dataset}`,
        timeout_ms: 120000,
        label: 're-fire replication send',
      },
    ],
    executor_state: { kind: 'kick_replication', dataset, tag },
  });

  await plans.registerWithWorker(envelope);
  process.stderr.write(
    `lthcs-ops: PLAN tool=${NAME} site=${JSON.stringify(siteLabel)} ` +
    `plan_id=${JSON.stringify(envelope.plan_id)} reason=${JSON.stringify(reason)}\n`
  );

  return { ok: true, plan: plans.toModelView(envelope) };
}

module.exports = { NAME, CATEGORY, DESCRIPTION, inputSchema, handler };
