'use strict';

// MUTATING lthcs-ops tool: kill_stuck_send({ site, dataset, reason })
//
// The documented correct remedy for the "stuck send" spiral
// (CLIENT_OPS_MCP_DESIGN.md §3, lthcs/CLAUDE.md "The stuck send spiral").
//
// The mechanism in plain terms, since future operators (and the model
// reading the tool description) need to see it: the hourly replication uses
// `zfs send | ssh recv zfs recv -F` with **no resume token**. If a transfer
// is wedged, the safe move is to KILL the in-flight send. The receiver does
// not have a partial dataset to clean up (no `-s`, no resume state) — it
// simply stays at its real latest snapshot. The orchestrator then computes
// a correct, recent send-base on its next fire. The wrong move — and the
// one that perpetuated the original incident — is `zfs rollback -R` on the
// receiver, which walks it backwards and is why the brain kept rebuilding
// an ever-older base. That verb is intentionally absent from this boundary
// (design doc §3, excluded tier); this tool is the right alternative.
//
// Killing processes is not mutating data, so this tool does NOT take a
// pre-mutate ZFS snapshot. That would be misleading insurance: there is
// nothing on disk to roll back to. Approval is still required.
//
// Result schema (success):
//   { ok: true, killed: <non-negative integer> }
//
// Errors:
//   { error: "unknown_site" | "invalid_dataset" | "invalid_reason" |
//            "kill_failed" }

const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'kill_stuck_send';
const CATEGORY = 'mutating';
const DESCRIPTION =
  'Cleanly kill an in-flight ZFS replication send for a dataset on a site ' +
  '(the sender). This is the correct remedy for a stuck send: because the ' +
  'recv uses no resume token, killing the partial transfer leaves the ' +
  'receiver at its real latest snapshot and the orchestrator computes a ' +
  'correct, recent base on its next fire — instead of an ever-older one. ' +
  'No data is mutated, so no pre-mutate snapshot is taken. Approval ' +
  'required. Returns the count of killed sender-side send processes only.';

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

// Same charset the other tools enforce. Anything outside it is rejected
// before we let the dataset string near the remote shell — defence against
// command injection through a model-supplied argument.
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

// Build the remote command. If the operator supplied `replication_kill_cmd`
// in site config, that wins (same `{dataset}` substitution rule as the kick
// tool, falling back to positional append). Otherwise use a safe default
// that:
//   1. lists PIDs of running `zfs send` processes whose argv contains the
//      dataset name (pgrep -af gives us "<pid> <full argv>"; awk filters by
//      substring),
//   2. emits the count on stdout (a single integer line we can parse),
//   3. SIGTERMs them.
//
// The dataset has been sanitised to the strict charset above, so no extra
// remote-shell quoting is required.
function buildKillCmd(template, dataset) {
  if (template) {
    return template.includes('{dataset}')
      ? template.replace(/\{dataset\}/g, dataset)
      : `${template} ${dataset}`;
  }
  return (
    `pids=$(pgrep -af 'zfs send' | awk -v ds=${dataset} ` +
    `'index($0, ds) > 0 { print $1 }'); ` +
    `count=$(printf '%s\\n' $pids | grep -c . || true); ` +
    `echo "$count"; ` +
    `[ -n "$pids" ] && kill -TERM $pids; ` +
    `exit 0`
  );
}

function parseKilledCount(stdout) {
  const first = String(stdout).split(/\r?\n/)[0].trim();
  if (!first) return null;
  // Reject anything that isn't a bare non-negative integer. `Number('')`
  // happily returns 0, hence the empty-string guard above.
  if (!/^\d+$/.test(first)) return null;
  const n = Number(first);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const dataset = sanitiseDataset(args && args.dataset);
  if (!dataset) return { error: 'invalid_dataset' };

  const reason = sanitiseReason(args && args.reason);
  if (!reason) return { error: 'invalid_reason' };

  // Audit line — same shape as the other mutating tools.
  process.stderr.write(
    `lthcs-ops: kill_stuck_send site=${JSON.stringify(siteLabel)} ` +
    `reason=${JSON.stringify(reason)}\n`
  );

  const remoteCmd = buildKillCmd(site.replication_kill_cmd, dataset);
  const res = await run('ssh', [...sshBaseArgs(site), remoteCmd], { timeoutMs: 30000 });
  if (!res.ok) return { error: 'kill_failed' };

  const killed = parseKilledCount(res.stdout);
  return { ok: true, killed: killed == null ? 0 : killed };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { sanitiseDataset, sanitiseReason, buildKillCmd, parseKilledCount },
};
