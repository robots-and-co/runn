'use strict';

// READ-ONLY lthcs-ops tool: create_snapshot_plan({ site, dataset, reason })
//
// Plan-then-apply counterpart of create_snapshot (CLIENT_OPS_MCP_DESIGN.md §5).
// Validates the same inputs, freezes the dynamic values (snapshot tag epoch),
// builds a plan envelope and registers it with the worker so a later
// apply_plan call can surface the full body on the approval card. Does NOT
// execute — the only path to execution is apply_plan({plan_id, reason}).
//
// Why read-only: no SSH is fired, no state is touched. The plan exists only
// in memory and the worker registry. Approval is unnecessary; the operator
// reviews the plan when apply_plan asks for approval to execute it.
//
// Result schema (success):
//   { ok: true, plan: <model view> }
//
// where <model view> = { plan_id, tool: "create_snapshot", created_at,
//   site_label, reason, affects: ["dataset:<ds>"],
//   steps: [{ kind: "ssh_exec", site_label, remote_command: "zfs snapshot ...",
//             timeout_ms: 30000, label: "take pre-mutate snapshot" }] }
//
// Errors:
//   { error: "unknown_site" | "invalid_dataset" | "invalid_reason" }

const { sanitiseDataset, buildTag } = require('./_snapshot')._internals;
const plans = require('./_plans');

const NAME = 'create_snapshot_plan';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Propose (without executing) an on-demand ZFS snapshot on a site. ' +
  'Returns a plan body — the exact `zfs snapshot <ds>@<tag>` remote ' +
  'command, the affected dataset, the frozen tag epoch — plus a plan_id. ' +
  'Use the matching apply_plan(plan_id, reason) tool to actually take the ' +
  'snapshot; that step requires approval and shows the operator this same ' +
  'plan body for review.';

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

  const dataset = sanitiseDataset(args && args.dataset);
  if (!dataset) return { error: 'invalid_dataset' };

  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  // Freeze the tag at plan time — the operator approves THIS tag, not
  // whatever tag would be re-derived at apply time.
  const tag = buildTag();
  const remote_command = `zfs snapshot ${dataset}@${tag}`;

  const envelope = plans.makeEnvelope({
    tool: 'create_snapshot',
    site_label: siteLabel,
    reason,
    affects: [`dataset:${dataset}`],
    steps_model_view: [{
      kind: 'ssh_exec',
      site_label: siteLabel,
      remote_command,
      timeout_ms: 30000,
      label: 'take pre-mutate snapshot',
    }],
    executor_state: { kind: 'create_snapshot', dataset, tag },
  });

  await plans.registerWithWorker(envelope);

  // Plan tools are read-only, but we still emit a stderr audit line so the
  // on-box log has a record of "this plan_id was minted, here is the reason"
  // independent of the .jsonl transcript. The pairing reason→plan_id lets
  // the operator correlate later if needed.
  process.stderr.write(
    `lthcs-ops: PLAN tool=${NAME} site=${JSON.stringify(siteLabel)} ` +
    `plan_id=${JSON.stringify(envelope.plan_id)} reason=${JSON.stringify(reason)}\n`
  );

  return { ok: true, plan: plans.toModelView(envelope) };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { sanitiseReason },
};
