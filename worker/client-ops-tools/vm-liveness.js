'use strict';

// READ-ONLY client-ops tool: vm_liveness({ site })
//
// Two probes, on the hypervisor reached via the site's SSH credentials:
//   1. `virsh domstate <vm_name>` — libvirt's view of the guest.
//   2. A TCP connect to <service_host>:<service_port> via the remote shell,
//      using bash's `/dev/tcp` so we don't need `nc` installed.
//
// Both `vm_name` and `service_port` live in the local site config (see
// client-ops-config.js). `service_host` defaults to "127.0.0.1" on the
// remote — i.e. the probe checks a loopback port bridged from the guest.
//
// Result schema (success):
//   { vm_state: "running"|"shut off"|"paused"|"crashed"|
//               "in shutdown"|"pmsuspended"|"unknown",
//     service_port_open: true|false }
//
// Errors: { error: "site_not_configured_for_vm_liveness" |
//                   "virsh_failed" }

const { sshBaseArgs, run, shellQuote } = require('./_ssh');

const NAME = 'vm_liveness';
const CATEGORY = 'read-only';
const DESCRIPTION =
  'Read-only liveness probe for a site\'s VM: libvirt domain state ' +
  'plus a TCP reachability check of the configured service port. ' +
  'No hostnames, IPs or VM names are returned.';

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: { site: { enum: siteNames } },
    required: ['site'],
    additionalProperties: false,
  };
}

const VALID_STATES = new Set([
  'running', 'shut off', 'paused', 'crashed',
  'in shutdown', 'pmsuspended',
]);

function normaliseState(s) {
  const k = String(s || '').trim().toLowerCase();
  return VALID_STATES.has(k) ? k : 'unknown';
}

async function handler(args, { sites }) {
  const site = sites[args && args.site];
  if (!site) return { error: 'unknown_site' };

  if (!site.vm_name || !site.service_port) {
    return { error: 'site_not_configured_for_vm_liveness' };
  }
  const serviceHost = site.service_host || '127.0.0.1';

  const ssh = sshBaseArgs(site);

  const virshRes = await run(
    'ssh', [...ssh, `virsh domstate ${shellQuote(site.vm_name)}`],
    { timeoutMs: 15000 },
  );
  if (!virshRes.ok) return { error: 'virsh_failed' };
  const vm_state = normaliseState(virshRes.stdout);

  // `bash -c '</dev/tcp/<host>/<port>'` exits 0 on a successful TCP connect,
  // non-zero on refusal/timeout. `timeout 5` caps the wait. We treat any
  // non-zero exit as port-closed without distinguishing the cause — the
  // distinction would leak network topology.
  const probeCmd =
    `timeout 5 bash -c ${shellQuote(`< /dev/tcp/${serviceHost}/${site.service_port}`)}`;
  const probeRes = await run('ssh', [...ssh, probeCmd], { timeoutMs: 15000 });

  return {
    vm_state,
    service_port_open: !!probeRes.ok,
  };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler,
  _internals: { normaliseState },
};
