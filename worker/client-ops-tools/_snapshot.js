'use strict';

// Pre-mutate auto-snapshot helper for the mutating tier of the client-ops MCP
// boundary. The design contract is in CLIENT_OPS_MCP_DESIGN.md §5: cheap
// snapshot before any change, so a bad mutation becomes "roll back to the
// pre-change snapshot" rather than an irreversible incident.
//
// Two callers:
//   1. The `create_snapshot` tool, whose entire purpose is to take one.
//   2. Future mutating tools (kick send, restart_service, …) that call this
//      first as a pre-hook to insure themselves before they touch state.
//
// Tag scheme: `runn-pre-mutate-<unix-seconds>`. The `runn-pre-mutate-` prefix
// is the discoverable convention §8.6 calls for — easily filtered for cleanup
// (`zfs list -t snapshot | grep ^runn-pre-mutate-`) and visibly distinct from
// the orchestrator's own replication snapshots.
//
// The dataset string is sanitised against the same charset the read-only tier
// uses, defending the remote shell from a model-supplied argument even though
// (a) the model is gated by the CLI's permission prompt before this code
// runs and (b) the remote command is sent via execFile, not a local shell.

const { sshBaseArgs, run } = require('./_ssh');

const DATASET_RE = /^[A-Za-z0-9._/\-]+$/;
function sanitiseDataset(s) {
  if (typeof s !== 'string' || !s.length || s.length > 255) return null;
  if (!DATASET_RE.test(s)) return null;
  return s;
}

function buildTag(nowSeconds) {
  const epoch = Number.isFinite(nowSeconds)
    ? Math.floor(nowSeconds)
    : Math.floor(Date.now() / 1000);
  return `runn-pre-mutate-${epoch}`;
}

// Run `zfs snapshot <dataset>@<tag>` on the site. Returns:
//   { ok: true,  tag, created }     // created = ISO-8601 UTC of the tag epoch
//   { ok: false, error: "<enum>" }  // error never embeds the dataset / host
//
// `opts.now` is a unix-seconds override exposed for the smoke test; production
// callers leave it unset.
async function createPreMutateSnapshot(site, dataset, opts) {
  if (!site || typeof site !== 'object') return { ok: false, error: 'unknown_site' };
  const safe = sanitiseDataset(dataset);
  if (!safe) return { ok: false, error: 'invalid_dataset' };

  const tag = buildTag(opts && opts.now);
  const remote = `zfs snapshot ${safe}@${tag}`;
  const res = await run('ssh', [...sshBaseArgs(site), remote], { timeoutMs: 30000 });
  if (!res.ok) return { ok: false, error: 'snapshot_create_failed' };

  // Derive `created` from the tag rather than re-parsing stdout; `zfs snapshot`
  // is silent on success and we wouldn't want stderr text in the result anyway.
  const epoch = Number(tag.slice('runn-pre-mutate-'.length));
  return { ok: true, tag, created: new Date(epoch * 1000).toISOString() };
}

module.exports = {
  createPreMutateSnapshot,
  _internals: { sanitiseDataset, buildTag },
};
