'use strict';

// READ-ONLY lthcs-ops tool: restart_service_plan({ site, service, reason })
//
// Plan-then-apply counterpart of restart_service (CLIENT_OPS_MCP_DESIGN.md §5).
// Same closed-enum service axis as the underlying tool — the model literally
// cannot express anything outside the SERVICE_ENUM. Returns a plan envelope
// describing the four (or three, for stateless services) steps that will
// run: prior status probe, optional pre-mutate snapshot, restart, new
// status probe.
//
// As elsewhere in the plan tier, the raw status_cmd / restart_cmd remote
// command texts are site-config secrets and are NOT echoed; the model view
// describes them abstractly. The stateful-dataset snapshot tag IS frozen at
// plan time so apply replays the exact same snapshot.

const restart = require('./restart-service');
const { buildTag } = require('./_snapshot')._internals;
const plans = require('./_plans');

const NAME = 'restart_service_plan';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Propose (without executing) a restart of a known service on a site. ' +
  'Service is a closed enum (firebird, node_red_executor). Returns a plan ' +
  'body: probe prior state, optionally take a pre-mutate ZFS snapshot for ' +
  'stateful services (firebird), restart, probe new state. Raw status / ' +
  'restart commands are site-config secrets and are summarised abstractly. ' +
  'apply_plan(plan_id, reason) executes the plan; approval shows this body.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:    { enum: siteNames },
      service: { enum: restart.SERVICE_ENUM.slice() },
      reason:  { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['site', 'service', 'reason'],
    additionalProperties: false,
  };
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const service = args && args.service;
  if (typeof service !== 'string' || !restart.SERVICE_ENUM.includes(service)) {
    return { error: 'invalid_service' };
  }

  const reason = restart._internals.sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  const servicesCfg = site.services || {};
  const svcCfg = servicesCfg[service];
  if (!svcCfg) return { error: 'service_not_configured_for_site' };

  const affects = [`service:${siteLabel}/${service}`];
  const steps = [
    {
      kind: 'ssh_exec_configured',
      site_label: siteLabel,
      remote_command_abstract: `<configured status_cmd for ${service} on ${siteLabel}>`,
      timeout_ms: 15000,
      label: 'probe prior service state',
    },
  ];

  let tag = null;
  if (svcCfg.stateful_dataset) {
    tag = buildTag();
    affects.push(`dataset:${svcCfg.stateful_dataset}`);
    steps.push({
      kind: 'ssh_exec',
      site_label: siteLabel,
      remote_command: `zfs snapshot ${svcCfg.stateful_dataset}@${tag}`,
      timeout_ms: 30000,
      label: 'take pre-mutate snapshot (service is stateful)',
    });
  }

  steps.push({
    kind: 'ssh_exec_configured',
    site_label: siteLabel,
    remote_command_abstract: `<configured restart_cmd for ${service} on ${siteLabel}>`,
    timeout_ms: 60000,
    label: 'restart the service',
  });
  steps.push({
    kind: 'ssh_exec_configured',
    site_label: siteLabel,
    remote_command_abstract: `<configured status_cmd for ${service} on ${siteLabel}>`,
    timeout_ms: 15000,
    label: 'probe new service state',
  });

  const envelope = plans.makeEnvelope({
    tool: 'restart_service',
    site_label: siteLabel,
    reason,
    affects,
    steps_model_view: steps,
    executor_state: { kind: 'restart_service', service, tag },
  });

  await plans.registerWithWorker(envelope);
  process.stderr.write(
    `lthcs-ops: PLAN tool=${NAME} site=${JSON.stringify(siteLabel)} ` +
    `service=${JSON.stringify(service)} ` +
    `plan_id=${JSON.stringify(envelope.plan_id)} reason=${JSON.stringify(reason)}\n`
  );

  return { ok: true, plan: plans.toModelView(envelope) };
}

module.exports = { NAME, CATEGORY, DESCRIPTION, inputSchema, handler };
