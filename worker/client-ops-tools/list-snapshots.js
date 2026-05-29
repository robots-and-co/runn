'use strict';

// READ-ONLY client-ops tool: list_snapshots({ site, dataset, limit? })
//
// Returns the most recent snapshots of a dataset, as timestamps only — the
// snapshot *names* are stripped before the result returns, since names
// embed the pool/dataset path that the boundary is built to hide.
//
// Result schema (success):
//   { count: N,                                  // total snapshots seen
//     snapshots: [ { created: "ISO-8601 UTC" } ] // up to `limit`, newest first
//   }
//
// Errors:
//   { error: "invalid_dataset" | "invalid_limit" |
//            "snapshot_list_failed" | "no_snapshots" }

const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'list_snapshots';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'List the most recent snapshots of a dataset on a site, as ' +
  'timestamps only (snapshot names are stripped). Useful for ' +
  'judging replication cadence without disclosing dataset paths.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:    { enum: siteNames },
      dataset: { type: 'string' },
      limit:   { type: 'integer', minimum: 1, maximum: 1000 },
    },
    required: ['site', 'dataset'],
    additionalProperties: false,
  };
}

const DATASET_RE = /^[A-Za-z0-9._/\-]+$/;
function sanitiseDataset(s) {
  if (typeof s !== 'string' || !s.length || s.length > 255) return null;
  if (!DATASET_RE.test(s)) return null;
  return s;
}

function sanitiseLimit(v) {
  if (v === undefined || v === null) return 50;
  if (!Number.isInteger(v) || v < 1 || v > 1000) return null;
  return v;
}

// Parse `zfs list -p -H -o creation -t snapshot -s creation <dataset>`
// (note: name column dropped at the source). One epoch per line, ascending.
function parseEpochs(stdout) {
  return stdout.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => Number(l.split(/\s+/)[0]))
    .filter(n => Number.isFinite(n) && n > 0);
}

async function handler(args, { sites }) {
  const site = sites[args && args.site];
  if (!site) return { error: 'unknown_site' };

  const dataset = sanitiseDataset(args && args.dataset);
  if (!dataset) return { error: 'invalid_dataset' };

  const limit = sanitiseLimit(args && args.limit);
  if (limit === null) return { error: 'invalid_limit' };

  const remote =
    `zfs list -p -H -o creation -t snapshot -s creation ${dataset}`;
  const res = await run('ssh', [...sshBaseArgs(site), remote], { timeoutMs: 15000 });
  if (!res.ok) return { error: 'snapshot_list_failed' };

  const epochs = parseEpochs(res.stdout);
  if (!epochs.length) return { error: 'no_snapshots' };

  // Newest-first, truncated to `limit`.
  const newest = epochs.slice(-limit).reverse();
  return {
    count: epochs.length,
    snapshots: newest.map(e => ({ created: new Date(e * 1000).toISOString() })),
  };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { sanitiseDataset, sanitiseLimit, parseEpochs },
};
