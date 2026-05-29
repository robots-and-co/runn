'use strict';

// READ-ONLY client-ops tool: zpool_status({ site })
//
// Returns per-pool health *without* echoing the real pool names back to the
// model. Pools are returned as an ordered list of opaque entries — by their
// position in `zpool list` output — so the model can tell "there are two
// pools and one is degraded" without learning either pool's name.
//
// Result schema (success):
//   { pools: [
//       { state: "online"|"degraded"|"faulted"|"removed"|"offline"|
//                "unavail"|"suspended"|"unknown",
//         scrub_in_progress: bool,
//         resilver_in_progress: bool }
//     ] }
//
// Errors: { error: "zpool_list_failed" | "zpool_status_failed" }
//
// We deliberately do NOT accept a model-supplied pool argument: a real pool
// name reaching this layer would already be a leak. The design doc lists
// `pool?` as illustrative; v1 of this tool just enumerates anonymously.

const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'zpool_status';
const DESCRIPTION =
  'Read-only ZFS pool health for a site. Returns an anonymised, ' +
  'ordered list of pools with their state and scrub/resilver flags. ' +
  'No pool names, dataset paths or hostnames are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: { site: { enum: siteNames } },
    required: ['site'],
    additionalProperties: false,
  };
}

const VALID_STATES = new Set([
  'online', 'degraded', 'faulted', 'removed',
  'offline', 'unavail', 'suspended',
]);

function normaliseState(s) {
  const k = String(s || '').toLowerCase();
  return VALID_STATES.has(k) ? k : 'unknown';
}

// `zpool list -H -o name,health` → one pool per line, tab-separated.
// We keep the NAME column ONLY to use as a key for the status-parse join;
// it is dropped before we return anything.
function parseList(stdout) {
  return stdout.split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [name, health] = l.split(/\s+/);
      return { name, state: normaliseState(health) };
    })
    .filter(p => p.name);
}

// `zpool status` output is a sequence of blocks, each starting with a line
// matching /^\s*pool:\s+<name>/. Within a block we look for "scan: scrub
// in progress" or "scan: resilver in progress" to set the flags.
function parseStatusBlocks(stdout) {
  const blocks = new Map(); // name -> { scrub, resilver }
  const lines = stdout.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = /^\s*pool:\s+(\S+)/.exec(line);
    if (m) {
      current = m[1];
      blocks.set(current, { scrub: false, resilver: false });
      continue;
    }
    if (!current) continue;
    const lower = line.toLowerCase();
    const b = blocks.get(current);
    if (lower.includes('scrub in progress'))    b.scrub = true;
    if (lower.includes('resilver in progress')) b.resilver = true;
  }
  return blocks;
}

async function handler(args, { sites }) {
  const site = sites[args && args.site];
  if (!site) return { error: 'unknown_site' };

  const ssh = sshBaseArgs(site);

  const listRes = await run('ssh', [...ssh, 'zpool list -H -o name,health'], { timeoutMs: 15000 });
  if (!listRes.ok) return { error: 'zpool_list_failed' };
  const listed = parseList(listRes.stdout);
  if (!listed.length) return { pools: [] };

  // `zpool status` for the scan flags. If it fails we still return the list
  // with scrub/resilver assumed false rather than blanking the result.
  const statusRes = await run('ssh', [...ssh, 'zpool status'], { timeoutMs: 15000 });
  const flags = statusRes.ok ? parseStatusBlocks(statusRes.stdout) : new Map();

  const pools = listed.map(p => {
    const f = flags.get(p.name) || { scrub: false, resilver: false };
    return {
      state: p.state,
      scrub_in_progress: !!f.scrub,
      resilver_in_progress: !!f.resilver,
    };
  });

  return { pools };
}

module.exports = {
  NAME, DESCRIPTION, inputSchema, handler,
  _internals: { parseList, parseStatusBlocks, normaliseState },
};
