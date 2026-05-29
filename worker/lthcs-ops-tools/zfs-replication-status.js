'use strict';

// READ-ONLY lthcs-ops tool: zfs_replication_status({ site, dataset? })
//
// First instance of the curated MCP boundary described in
// CLIENT_OPS_MCP_DESIGN.md §3 + §8.4. The contract this file is upholding:
//
//   1. The model passes ABSTRACT site labels ("A", "B", "RECEIVER", …). We
//      resolve them to {host,user,key} via the local-only config — those real
//      values never appear in any string we return.
//   2. We SSH over to the site, run scoped read-only `zpool`/`zfs` queries,
//      and return a STRICT result schema. Raw stdout never escapes this file.
//   3. Errors are emitted as enum codes — never a stringified exception that
//      could carry the host/user/key path embedded in `execFile`'s err.message.
//
// Result schema (only these keys, ever):
//   { pool: "primary",
//     healthy: true|false,
//     latest_snapshot?: ISO-8601 UTC,    // only when `dataset` was given
//     lag_seconds?:     integer >= 0,    // only when `dataset` was given
//     notes?: ["scrub_in_progress" | "resilver_in_progress" | …],
//     error?: "<enum>" }                 // mutually exclusive with the success keys

const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'zfs_replication_status';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Read-only health probe for a site\'s ZFS replication: pool health, ' +
  'latest snapshot timestamp and lag (when a dataset is given). ' +
  'No hostnames, paths, or pool names are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:    { enum: siteNames },
      dataset: { type: 'string' },
    },
    required: ['site'],
    additionalProperties: false,
  };
}

// Dataset names must be alnum / _ - . / only. Anything outside that charset
// is rejected before we hand the string to the remote shell — defence against
// command injection through the model-supplied argument.
const DATASET_RE = /^[A-Za-z0-9._/\-]+$/;
function sanitiseDataset(s) {
  if (typeof s !== 'string' || !s.length || s.length > 255) return null;
  if (!DATASET_RE.test(s)) return null;
  return s;
}

// Parse `zpool status -x` output. We do NOT return any of this text — only
// a boolean + a short set of enum-style notes.
function parseHealth(stdout) {
  const lower = stdout.toLowerCase();
  const notes = [];
  if (lower.includes('scrub in progress'))    notes.push('scrub_in_progress');
  if (lower.includes('resilver in progress')) notes.push('resilver_in_progress');

  if (lower.includes('all pools are healthy')) {
    return { healthy: true, notes };
  }
  // `zpool status -x` only lists pools that need attention; anything matching
  // a degraded/faulted state in the printed `state:` line is unhealthy.
  const unhealthy = /\bstate:\s*(degraded|faulted|offline|unavail|removed|suspended)/i.test(stdout);
  return { healthy: !unhealthy, notes };
}

// Parse `zfs list -p -H -o creation,name -t snapshot -s creation <dataset>`.
// With -p the creation column is a unix epoch (seconds). Sorted ascending,
// so the newest is the LAST line. We only extract the epoch — the name
// column (pool/dataset@snap) is discarded so it can't leak.
function parseLatestSnapshot(stdout) {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const firstField = last.split(/\s+/)[0];
  const epoch = Number(firstField);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return { epoch, count: lines.length };
}

async function handler(args, { sites }) {
  const siteLabel = args && args.site;
  const datasetIn = args && args.dataset;

  const site = sites[siteLabel];
  // The MCP enum should already reject unknown labels, but defend in depth.
  if (!site) return { error: 'unknown_site' };

  let datasetSafe = null;
  if (datasetIn !== undefined && datasetIn !== null && datasetIn !== '') {
    datasetSafe = sanitiseDataset(datasetIn);
    if (!datasetSafe) return { error: 'invalid_dataset' };
  }

  const sshArgs = sshBaseArgs(site);

  // 1) Pool health. `zpool status -x` is the canonical "anything wrong?" probe.
  const healthRes = await run('ssh', [...sshArgs, 'zpool status -x'], { timeoutMs: 15000 });
  if (!healthRes.ok) return { error: 'health_probe_failed' };
  const { healthy, notes } = parseHealth(healthRes.stdout);

  // 2) Snapshot probe — only when a dataset was specified. Without a dataset
  //    we deliberately do NOT list filesystems (that would leak the dataset
  //    hierarchy); a follow-up tool can enumerate against known logical names.
  let snap = null;
  if (datasetSafe) {
    const remoteCmd =
      `zfs list -p -H -o creation,name -t snapshot -s creation ${datasetSafe}`;
    const snapRes = await run('ssh', [...sshArgs, remoteCmd], { timeoutMs: 15000 });
    if (!snapRes.ok) {
      // Two common cases: dataset doesn't exist, or ssh/zfs errored. We
      // collapse them — distinguishing them would risk leaking which datasets
      // do/don't exist. Health is still useful, so we return it.
      return { pool: 'primary', healthy, ...(notes.length ? { notes } : {}), error: 'snapshot_probe_failed' };
    }
    snap = parseLatestSnapshot(snapRes.stdout);
    if (!snap) {
      return { pool: 'primary', healthy, ...(notes.length ? { notes } : {}), error: 'no_snapshots' };
    }
  }

  const out = { pool: 'primary', healthy };
  if (notes.length) out.notes = notes;
  if (snap) {
    out.latest_snapshot = new Date(snap.epoch * 1000).toISOString();
    out.lag_seconds = Math.max(0, Math.floor(Date.now() / 1000) - snap.epoch);
  }
  return out;
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  // Exposed for unit-style tests under worker/lthcs-ops-tools/.
  _internals: { sanitiseDataset, parseHealth, parseLatestSnapshot },
};
