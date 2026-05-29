'use strict';

// READ-ONLY lthcs-ops tool: raw_ssh_exec_plan({ site, command, justification })
//
// Plan-then-apply counterpart of the raw-SSH escape hatch
// (CLIENT_OPS_MCP_DESIGN.md §5, §8.5). Same opt-in flag and same "no always
// allow" treatment as the underlying tool — the plan tool exists only when
// LTHCS_OPS_ALLOW_RAW_SSH=1 is set, and apply_plan inherits the no-blanket-
// approval rule.
//
// The model view of the plan IS the command — that's the whole point of the
// hatch: an arbitrary, operator-reviewable command. So unlike the other plan
// tools, raw_ssh_exec_plan echoes the literal remote_command (the model
// supplied it; not a config secret). Justification is captured for both the
// stderr audit and the apply-time dedicated audit channel.
//
// NOTE: this plan tool does NOT write to the dedicated raw-ssh audit log —
// nothing has executed yet. The audit log fires on apply_plan, mirroring the
// design doc's "every invocation appends start/end entries" promise. Planning
// is logged only to the standard plan stderr line.

const rawSsh = require('./raw-ssh-exec');
const plans = require('./_plans');

const NAME = 'raw_ssh_exec_plan';
const CATEGORY = 'read-only';
const ENV_FLAG = rawSsh.ENV_FLAG;

const DESCRIPTION =
  'Propose (without executing) an arbitrary raw-SSH command on a site — ' +
  'the planning step for the escape hatch. Disabled by default; the ' +
  'operator opts in per Runn invocation via env ' + ENV_FLAG + '=1. The ' +
  'plan body echoes the literal remote command and justification for ' +
  'review. apply_plan(plan_id, reason) executes; that step requires Allow ' +
  'on every single call (no "always allow") and appends entries to the ' +
  'dedicated audit log.';

function isEnabled() {
  return process.env[ENV_FLAG] === '1';
}

function inputSchema(siteNames) {
  // Mirror the input shape of raw_ssh_exec — same caps, same required fields.
  return {
    type: 'object',
    properties: {
      site:          { enum: siteNames },
      command:       { type: 'string', minLength: 1, maxLength: rawSsh._internals.COMMAND_MAX },
      justification: { type: 'string', minLength: 1, maxLength: rawSsh._internals.JUSTIFICATION_MAX },
    },
    required: ['site', 'command', 'justification'],
    additionalProperties: false,
  };
}

async function handler(args, { sites }) {
  // Defence-in-depth re-check of the env flag, mirroring raw_ssh_exec itself.
  if (!isEnabled()) return { error: 'raw_ssh_disabled' };

  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const command = rawSsh._internals.sanitiseCommand(args && args.command);
  if (!command) return { error: 'invalid_command' };

  const justification = rawSsh._internals.sanitiseJustification(args && args.justification);
  if (!justification) return { error: 'invalid_justification' };

  const envelope = plans.makeEnvelope({
    tool: 'raw_ssh_exec',
    site_label: siteLabel,
    // Reuse `reason` slot for the audit-readable justification so the
    // envelope shape stays uniform across tools. The apply-time executor
    // writes both `reason` (from apply_plan) and this `justification` into
    // the dedicated audit log.
    reason: justification,
    affects: [`site:${siteLabel}`],
    steps_model_view: [{
      kind: 'ssh_exec',
      site_label: siteLabel,
      remote_command: command,
      timeout_ms: 120000,
      label: 'run arbitrary command (ESCAPE HATCH)',
      danger: true,
    }],
    executor_state: { kind: 'raw_ssh_exec', command, justification },
  });

  await plans.registerWithWorker(envelope);
  process.stderr.write(
    `lthcs-ops: PLAN tool=${NAME} site=${JSON.stringify(siteLabel)} ` +
    `plan_id=${JSON.stringify(envelope.plan_id)} ` +
    `justification=${JSON.stringify(justification)}\n`
  );

  return { ok: true, plan: plans.toModelView(envelope) };
}

module.exports = { NAME, CATEGORY, DESCRIPTION, inputSchema, handler, isEnabled, ENV_FLAG };
