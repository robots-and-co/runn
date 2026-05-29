'use strict';

// READ-ONLY lthcs-ops tool: kill_stuck_send_plan({ site, dataset, reason })
//
// Plan-then-apply counterpart of kill_stuck_send (CLIENT_OPS_MCP_DESIGN.md §5).
// Validates the same inputs and produces a single-step plan: kill the
// in-flight `zfs send` for <dataset> on <site>. No pre-mutate snapshot —
// killing processes does not mutate on-disk data, so there is nothing to
// roll back to (same invariant as the underlying tool).
//
// As with kick_replication_plan, if the site has a configured
// `replication_kill_cmd` the raw text is a site-config secret and is NOT
// echoed; the model view describes it abstractly. The fallback recipe (no
// site-configured kill command) IS shown explicitly — it's a known, local
// pgrep+SIGTERM pipeline parameterised only by the model-supplied dataset,
// so showing it leaks nothing new.

const { sanitiseDataset } = require('./_snapshot')._internals;
const kill = require('./kill-stuck-send');
const plans = require('./_plans');

const NAME = 'kill_stuck_send_plan';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Propose (without executing) killing an in-flight ZFS replication send ' +
  'for a dataset on a site. The receiver uses no resume token, so killing ' +
  'the partial is safe: it leaves the receiver at its real latest snapshot ' +
  'and the orchestrator computes a correct base on the next fire. No ' +
  'pre-mutate snapshot is taken (no on-disk data to roll back). Returns a ' +
  'plan body for review; apply_plan(plan_id, reason) executes it.';

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

  const reason = kill._internals.sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  // If the site has a configured kill command, describe it abstractly. If
  // not, show the fallback recipe verbatim — it's a known local pipeline,
  // not a config secret.
  let step;
  if (site.replication_kill_cmd) {
    step = {
      kind: 'ssh_exec_configured',
      site_label: siteLabel,
      remote_command_abstract:
        `<configured kill command for site ${siteLabel}> ${dataset}`,
      timeout_ms: 30000,
      label: 'kill in-flight zfs send (configured recipe)',
    };
  } else {
    step = {
      kind: 'ssh_exec',
      site_label: siteLabel,
      remote_command: kill._internals.buildKillCmd(undefined, dataset),
      timeout_ms: 30000,
      label: 'kill in-flight zfs send (default pgrep/SIGTERM recipe)',
    };
  }

  const envelope = plans.makeEnvelope({
    tool: 'kill_stuck_send',
    site_label: siteLabel,
    reason,
    affects: [`replication:${siteLabel}/${dataset}`],
    steps_model_view: [step],
    executor_state: { kind: 'kill_stuck_send', dataset },
  });

  await plans.registerWithWorker(envelope);
  process.stderr.write(
    `lthcs-ops: PLAN tool=${NAME} site=${JSON.stringify(siteLabel)} ` +
    `plan_id=${JSON.stringify(envelope.plan_id)} reason=${JSON.stringify(reason)}\n`
  );

  return { ok: true, plan: plans.toModelView(envelope) };
}

module.exports = { NAME, CATEGORY, DESCRIPTION, inputSchema, handler };
