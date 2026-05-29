'use strict';

// MUTATING lthcs-ops tool: restart_service({ site, service, reason })
//
// Closed enums on BOTH axes — `site` is the configured site label set, and
// `service` is the hard-coded SERVICE_ENUM below. The model literally cannot
// express "restart whatever I want": its vocabulary is exactly the entries
// here. Extending the menu is a deliberate code change, not a free-form
// argument — that closure is what makes the boundary deterministic on the
// action axis (CLIENT_OPS_MCP_DESIGN.md §3, "closed enums and logical names,
// not free-form hostnames or commands").
//
// Each (site, service) pair is wired up in the local site config under
// `services.<name>` with three fields:
//   - status_cmd       : remote command whose first stdout line is the state
//                        token we normalise (active|inactive|…). Exit 0 means
//                        we trust the output; non-zero collapses to "unknown".
//   - restart_cmd      : remote command that performs the restart.
//   - stateful_dataset : optional ZFS dataset. When set, we take a
//                        pre-mutate snapshot BEFORE the restart_cmd runs.
//                        This is the §5 snapshot-before-mutate hook, scoped
//                        to services that touch state on disk (firebird's
//                        .fdb, …). Stateless services (node_red_executor)
//                        leave it unset — taking a snapshot of nothing would
//                        be misleading insurance.
//
// Approval is inherited from the CLI's `--permission-prompt-tool` gate (§4);
// a denied call never reaches this handler.
//
// Result schema (success):
//   { service,
//     prior_state: "running"|"stopped"|"unknown",
//     new_state:   "running"|"stopped"|"unknown",
//     restarted_at: ISO-8601 UTC,
//     snapshot_tag?: "runn-pre-mutate-<epoch>" }  // present iff stateful_dataset
//
// Errors:
//   { error: "unknown_site" | "invalid_service" | "invalid_reason" |
//            "service_not_configured_for_site" |
//            "snapshot_create_failed" | "restart_failed" }

const { sshBaseArgs, run } = require('./_ssh');
const { createPreMutateSnapshot } = require('./_snapshot');

const NAME = 'restart_service';
const CATEGORY = 'mutating';

// THE closed service enum. Extending this is a deliberate, reviewed code
// change. Adding a string here is opening a new verb on the boundary; do not
// do it casually and do not accept free-form values to satisfy an ad-hoc
// request — author a new entry and the matching site config instead.
const SERVICE_ENUM = ['firebird', 'node_red_executor'];

const DESCRIPTION =
  'Restart a known, named service on a site. The service argument is a ' +
  'closed enum (firebird, node_red_executor) — anything else is a schema ' +
  'error, never a shell attempt. Approval required. For services that ' +
  'touch on-disk state, a pre-mutate ZFS snapshot is taken first as cheap ' +
  'insurance. Returns prior/new state (running|stopped|unknown), the ' +
  'restart timestamp, and (when applicable) the snapshot tag — no host, ' +
  'pool, or command text.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:    { enum: siteNames },
      service: { enum: SERVICE_ENUM.slice() },
      reason:  { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['site', 'service', 'reason'],
    additionalProperties: false,
  };
}

function sanitiseReason(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.length || trimmed.length > 500) return null;
  return trimmed;
}

// Normalise the status_cmd's first stdout line into our closed state tri-set.
// We deliberately collapse to {running, stopped, unknown} so the model never
// sees raw status text (which can carry hostnames, PIDs, paths). Operators
// configuring status_cmd should arrange for it to emit one of the documented
// tokens; anything else (or a non-zero exit) becomes "unknown".
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

async function probeState(site, statusCmd) {
  const res = await run('ssh', [...sshBaseArgs(site), statusCmd], { timeoutMs: 15000 });
  return normaliseServiceState(res.ok, res.stdout);
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  // Defence in depth: enforce the closed service enum HERE, before any shell
  // attempt, regardless of whether the CLI did schema validation upstream.
  // The acceptance criterion explicitly demands "schema error, not a shell
  // attempt" — that contract is met server-side too.
  const service = args && args.service;
  if (typeof service !== 'string' || !SERVICE_ENUM.includes(service)) {
    return { error: 'invalid_service' };
  }

  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  const servicesCfg = site.services || {};
  const svcCfg = servicesCfg[service];
  if (!svcCfg) return { error: 'service_not_configured_for_site' };

  // Audit line — site + service labels are abstract; reason is operator-
  // readable. Same shape as the other mutating tools.
  process.stderr.write(
    `lthcs-ops: restart_service site=${JSON.stringify(siteLabel)} ` +
    `service=${JSON.stringify(service)} reason=${JSON.stringify(reason)}\n`
  );

  const prior_state = await probeState(site, svcCfg.status_cmd);

  let snapshot_tag;
  if (svcCfg.stateful_dataset) {
    const snap = await createPreMutateSnapshot(site, svcCfg.stateful_dataset);
    if (!snap.ok) {
      return { error: snap.error === 'invalid_dataset'
        ? 'service_not_configured_for_site'
        : 'snapshot_create_failed' };
    }
    snapshot_tag = snap.tag;
  }

  const restartRes = await run(
    'ssh', [...sshBaseArgs(site), svcCfg.restart_cmd],
    { timeoutMs: 60000 },
  );
  const restarted_at = new Date().toISOString();
  if (!restartRes.ok) {
    const out = { error: 'restart_failed', service, prior_state };
    if (snapshot_tag) out.snapshot_tag = snapshot_tag;
    return out;
  }

  const new_state = await probeState(site, svcCfg.status_cmd);

  const result = { service, prior_state, new_state, restarted_at };
  if (snapshot_tag) result.snapshot_tag = snapshot_tag;
  return result;
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  SERVICE_ENUM,
  _internals: { sanitiseReason, normaliseServiceState },
};
