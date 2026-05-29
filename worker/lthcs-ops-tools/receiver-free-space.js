'use strict';

// READ-ONLY lthcs-ops tool: receiver_free_space({ site })
//
// Aggregate ZFS pool capacity across the site, so the model can answer
// "is the receiver about to run out of room?" without learning a single
// pool name. Numbers are summed; per-pool breakdowns would re-introduce
// pool-identity correlation across calls and aren't needed for the
// receive-base-filling question this tool is for.
//
// Result schema (success):
//   { pools: N,
//     total_bytes:     integer >= 0,
//     allocated_bytes: integer >= 0,
//     free_bytes:      integer >= 0,
//     used_percent:    number 0..100 (one decimal) }
//
// Errors: { error: "zpool_list_failed" | "no_pools" }

const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'receiver_free_space';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Aggregate ZFS pool capacity for a site (typically the receiver). ' +
  'Returns summed total/allocated/free bytes and used percentage. ' +
  'No pool names are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: { site: { enum: siteNames } },
    required: ['site'],
    additionalProperties: false,
  };
}

// `zpool list -Hp -o size,alloc,free` — three integer columns per pool,
// tab-separated. -p forces raw bytes (otherwise we'd get "1.2T" suffixes).
function parseSpace(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 3) continue;
    const [size, alloc, free] = cols.map(Number);
    if (![size, alloc, free].every(n => Number.isFinite(n) && n >= 0)) continue;
    rows.push({ size, alloc, free });
  }
  return rows;
}

async function handler(args, { sites }) {
  const site = sites[args && args.site];
  if (!site) return { error: 'unknown_site' };

  const res = await run(
    'ssh', [...sshBaseArgs(site), 'zpool list -Hp -o size,alloc,free'],
    { timeoutMs: 15000 },
  );
  if (!res.ok) return { error: 'zpool_list_failed' };

  const rows = parseSpace(res.stdout);
  if (!rows.length) return { error: 'no_pools' };

  let total = 0, alloc = 0, free = 0;
  for (const r of rows) { total += r.size; alloc += r.alloc; free += r.free; }
  const used_percent = total > 0
    ? Math.round((alloc / total) * 1000) / 10
    : 0;

  return {
    pools: rows.length,
    total_bytes:     total,
    allocated_bytes: alloc,
    free_bytes:      free,
    used_percent,
  };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { parseSpace },
};
