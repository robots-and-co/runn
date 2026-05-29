'use strict';

// MUTATING lthcs-ops tool: apply_plan({ plan_id, reason })
//
// The single execution path for a previously-returned plan
// (CLIENT_OPS_MCP_DESIGN.md §5). Closes the design doc's plan-then-apply
// roadmap: every `*_plan` tool builds a frozen envelope, and this tool — and
// only this tool — runs one. There is no way to execute a plan body except
// via apply_plan with its plan_id; that's the point of the contract.
//
// Approval flow:
//   * The CLI's --permission-prompt-tool gate fires before this handler
//     runs, exactly like every other mutating tool. Token-scoped plan
//     storage in the worker means /permissions/request can look up the
//     full plan body by plan_id BEFORE rendering the approval card, so
//     the operator sees the original plan (steps, affects, frozen tags),
//     not just the opaque id. See worker/server.js lookupSessionPlan().
//   * apply_plan is permanently ineligible for "always allow" (worker's
//     isAlwaysAllowEligible). Each apply has to be reviewed and approved
//     individually — otherwise plan-then-apply collapses into a single
//     blanket-approved step.
//
// Plan storage:
//   * In-process Map in worker/lthcs-ops-tools/_plans.js. The lthcs-ops
//     server is spawned per Claude session, so the Map is naturally
//     session-scoped and dies when the subprocess exits. The spec's
//     "no cross-session reuse" follows for free.
//   * A plan is single-use: apply_plan deletes it from the store on a
//     successful dispatch (regardless of execution outcome). The
//     operator can re-plan if they need another shot.
//
// Result schema: the per-tool result shape is preserved — apply_plan wraps
// it in `{ ok: true, plan_id, tool, result: <per-tool result> }` so callers
// can correlate. On any error (lookup, executor, or per-tool failure),
// `result` carries the per-tool error envelope.
//
// Errors (this tool, not the dispatched executor):
//   { error: "unknown_plan" | "invalid_reason" | "executor_error" }

const { sshBaseArgs, run } = require('./_ssh');
const plans = require('./_plans');

const NAME = 'apply_plan';
const CATEGORY = 'mutating';
const DESCRIPTION =
  'Execute a previously-returned plan from a `*_plan` tool, looked up by ' +
  'plan_id. Approval is required and the approval card shows the full ' +
  'original plan body — not just the id — for review. apply_plan can never ' +
  'be granted "always allow"; each execution is a deliberate, individual ' +
  'decision. A plan is single-use; mint a new one to re-run.';

function inputSchema(/* siteNames */) {
  return {
    type: 'object',
    properties: {
      plan_id: { type: 'string', minLength: 1, maxLength: 128 },
      reason:  { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['plan_id', 'reason'],
    additionalProperties: false,
  };
}

function sanitiseReason(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.length || trimmed.length > 500) return null;
  return trimmed;
}

// ── Executors ────────────────────────────────────────────────────────────
// One per source tool. Each takes `(envelope, site, applyReason)` and returns
// the same result shape the original tool would have produced — so the
// model's reply shape is preserved whether it called the original tool or
// went through plan + apply. Frozen state (tags, commands) is read from
// envelope._executor_state so the apply runs the EXACT plan, not a re-derived
// one. That's what makes the operator's review of the plan meaningful.

async function execCreateSnapshot(envelope, site /*, applyReason */) {
  const { dataset, tag } = envelope._executor_state;
  const remote = `zfs snapshot ${dataset}@${tag}`;
  const res = await run('ssh', [...sshBaseArgs(site), remote], { timeoutMs: 30000 });
  if (!res.ok) return { error: 'snapshot_create_failed' };
  // Derive `created` from the same tag the plan locked in.
  const epoch = Number(tag.slice('runn-pre-mutate-'.length));
  return { ok: true, tag, created: new Date(epoch * 1000).toISOString() };
}

async function execKickReplication(envelope, site /*, applyReason */) {
  const { dataset, tag } = envelope._executor_state;
  // Step 1: pre-mutate snapshot with the FROZEN tag from plan time.
  const snapRes = await run('ssh', [
    ...sshBaseArgs(site), `zfs snapshot ${dataset}@${tag}`,
  ], { timeoutMs: 30000 });
  if (!snapRes.ok) return { error: 'snapshot_create_failed' };

  // Step 2: kick. Build the remote command from live site config (same as
  // the direct tool would). The plan body summarised this abstractly; the
  // raw text never made it into the envelope.
  const template = site.replication_kick_cmd;
  if (!template) return { error: 'site_not_configured_for_kick', snapshot_tag: tag };
  const kickCmd = template.includes('{dataset}')
    ? template.replace(/\{dataset\}/g, dataset)
    : `${template} ${dataset}`;
  const kickRes = await run('ssh', [...sshBaseArgs(site), kickCmd], { timeoutMs: 120000 });
  if (!kickRes.ok) return { error: 'kick_failed', snapshot_tag: tag };

  return { ok: true, snapshot_tag: tag, fired: true };
}

async function execKillStuckSend(envelope, site /*, applyReason */) {
  const { dataset } = envelope._executor_state;
  const template = site.replication_kill_cmd;
  const remoteCmd = template
    ? (template.includes('{dataset}') ? template.replace(/\{dataset\}/g, dataset) : `${template} ${dataset}`)
    // Same fallback as the direct tool — kept in sync via the plan tool's
    // build at plan time, but the executor rebuilds it here so a malformed
    // envelope can't smuggle a different command in.
    : (
        `pids=$(pgrep -af 'zfs send' | awk -v ds=${dataset} ` +
        `'index($0, ds) > 0 { print $1 }'); ` +
        `count=$(printf '%s\\n' $pids | grep -c . || true); ` +
        `echo "$count"; ` +
        `[ -n "$pids" ] && kill -TERM $pids; ` +
        `exit 0`
      );
  const res = await run('ssh', [...sshBaseArgs(site), remoteCmd], { timeoutMs: 30000 });
  if (!res.ok) return { error: 'kill_failed' };
  // parseKilledCount logic — first line non-negative integer, else 0.
  const first = String(res.stdout || '').split(/\r?\n/)[0].trim();
  const killed = /^\d+$/.test(first) ? Number(first) : 0;
  return { ok: true, killed };
}

const RUNNING_TOKENS = new Set(['running', 'active', 'started', 'activating']);
const STOPPED_TOKENS = new Set(['stopped', 'inactive', 'failed', 'exited', 'dead', 'deactivating']);
function normaliseServiceState(ok, stdout) {
  if (!ok) return 'unknown';
  const first = String(stdout || '').split(/\r?\n/)[0].trim().toLowerCase();
  if (!first) return 'unknown';
  if (RUNNING_TOKENS.has(first)) return 'running';
  if (STOPPED_TOKENS.has(first)) return 'stopped';
  return 'unknown';
}

async function execRestartService(envelope, site /*, applyReason */) {
  const { service, tag } = envelope._executor_state;
  const svcCfg = (site.services || {})[service];
  if (!svcCfg) return { error: 'service_not_configured_for_site' };

  const prior = await run('ssh', [...sshBaseArgs(site), svcCfg.status_cmd], { timeoutMs: 15000 });
  const prior_state = normaliseServiceState(prior.ok, prior.stdout);

  let snapshot_tag;
  if (svcCfg.stateful_dataset && tag) {
    const snapRes = await run('ssh', [
      ...sshBaseArgs(site), `zfs snapshot ${svcCfg.stateful_dataset}@${tag}`,
    ], { timeoutMs: 30000 });
    if (!snapRes.ok) return { error: 'snapshot_create_failed' };
    snapshot_tag = tag;
  }

  const restartRes = await run('ssh', [...sshBaseArgs(site), svcCfg.restart_cmd], { timeoutMs: 60000 });
  const restarted_at = new Date().toISOString();
  if (!restartRes.ok) {
    const out = { error: 'restart_failed', service, prior_state };
    if (snapshot_tag) out.snapshot_tag = snapshot_tag;
    return out;
  }

  const newProbe = await run('ssh', [...sshBaseArgs(site), svcCfg.status_cmd], { timeoutMs: 15000 });
  const new_state = normaliseServiceState(newProbe.ok, newProbe.stdout);

  const result = { service, prior_state, new_state, restarted_at };
  if (snapshot_tag) result.snapshot_tag = snapshot_tag;
  return result;
}

// raw_ssh_exec apply path — re-checks the env flag, writes the dedicated
// start/end audit entries, and runs the command. Same shape as the direct
// raw_ssh_exec tool's handler.
async function execRawSshExec(envelope, site, applyReason) {
  // Lazy require avoids circular load via the registry.
  const rawSsh = require('./raw-ssh-exec');
  if (!rawSsh.isEnabled()) return { error: 'raw_ssh_disabled' };

  const { command, justification } = envelope._executor_state;
  const startedAt = new Date().toISOString();
  try {
    rawSsh._internals.appendAudit({
      phase: 'start', ts: startedAt, tool: 'raw_ssh_exec',
      via: 'apply_plan', plan_id: envelope.plan_id,
      site: envelope.site_label,
      resolved_host: site.host, resolved_user: site.user,
      justification, apply_reason: applyReason,
      command,
    });
  } catch (err) {
    process.stderr.write(
      `lthcs-ops: apply_plan/raw_ssh_exec audit append failed: ${err && err.message}\n`
    );
    return { error: 'audit_log_failed' };
  }
  process.stderr.write(
    `lthcs-ops: RAW_SSH_EXEC (via apply_plan) site=${JSON.stringify(envelope.site_label)} ` +
    `justification=${JSON.stringify(justification)}\n`
  );

  const t0 = Date.now();
  const res = await run('ssh', [...sshBaseArgs(site), command], { timeoutMs: 120000 });
  const duration_ms = Date.now() - t0;
  const stdoutT = rawSsh._internals.truncate(res.stdout, rawSsh._internals.STDOUT_MAX);
  const stderrT = rawSsh._internals.truncate(res.stderr, rawSsh._internals.STDERR_MAX);

  try {
    rawSsh._internals.appendAudit({
      phase: 'end', ts: new Date().toISOString(), tool: 'raw_ssh_exec',
      via: 'apply_plan', plan_id: envelope.plan_id,
      site: envelope.site_label, justification, apply_reason: applyReason,
      ok: !!res.ok, duration_ms,
      stdout_bytes: res.stdout.length, stderr_bytes: res.stderr.length,
    });
  } catch (err) {
    process.stderr.write(
      `lthcs-ops: apply_plan/raw_ssh_exec audit (end) failed: ${err && err.message}\n`
    );
  }

  return {
    ok: !!res.ok, duration_ms,
    stdout_truncated: stdoutT.truncated, stderr_truncated: stderrT.truncated,
    stdout: stdoutT.text, stderr: stderrT.text,
  };
}

const EXECUTORS = {
  create_snapshot:  execCreateSnapshot,
  kick_replication: execKickReplication,
  kill_stuck_send:  execKillStuckSend,
  restart_service:  execRestartService,
  raw_ssh_exec:     execRawSshExec,
};

async function handler(args, { sites }) {
  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  const plan_id = args && args.plan_id;
  const envelope = plans.getPlan(plan_id);
  if (!envelope) return { error: 'unknown_plan' };

  const site = sites[envelope.site_label];
  if (!site) {
    // The plan referenced a site that's no longer in config. Drop the stale
    // plan and surface the error.
    plans.deletePlan(plan_id);
    return { error: 'unknown_site' };
  }

  const exec = EXECUTORS[envelope.tool];
  if (!exec) {
    plans.deletePlan(plan_id);
    return { error: 'executor_error', detail: `no executor for tool ${envelope.tool}` };
  }

  // Audit line for the apply step. Echoes the plan_id so the on-box log can
  // be correlated with the earlier PLAN line. The mutating audit line in
  // worker/lthcs-ops.js fires on tool=apply_plan too (covering the wire).
  process.stderr.write(
    `lthcs-ops: APPLY_PLAN plan_id=${JSON.stringify(plan_id)} ` +
    `tool=${JSON.stringify(envelope.tool)} site=${JSON.stringify(envelope.site_label)} ` +
    `apply_reason=${JSON.stringify(reason)}\n`
  );

  let result;
  try {
    result = await exec(envelope, site, reason);
  } catch (err) {
    process.stderr.write(
      `lthcs-ops: apply_plan executor for ${envelope.tool} threw: ` +
      `${err && err.message ? err.message : err}\n`
    );
    plans.deletePlan(plan_id);
    return { error: 'executor_error', tool: envelope.tool };
  }

  // Single-use semantic: regardless of executor outcome, the plan is spent.
  // The operator must re-plan to retry (which is exactly the review path we
  // want — a retry is not a "free" repeat of an approved action).
  plans.deletePlan(plan_id);

  return { ok: true, plan_id, tool: envelope.tool, result };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: {
    sanitiseReason, normaliseServiceState, EXECUTORS,
    execCreateSnapshot, execKickReplication, execKillStuckSend,
    execRestartService, execRawSshExec,
  },
};
