'use strict';

// Local-only site/secret config loader for the lthcs-ops MCP server (the
// per-client implementation of the client-ops boundary for lthcs; see
// CLIENT_OPS_MCP_DESIGN.md §3, §8.2, §8.7).
//
// The contract: the model never sees real hostnames/users/keys. The server
// resolves the abstract site label ("A", "B", "RECEIVER", …) to a concrete
// `{ host, user, ssh_key_path }` here, server-side, and that mapping never
// leaves the worker container.
//
// The path is read from $LTHCS_OPS_CONFIG (mirroring how
// worker/mcp-permission.js reads its token from env), with a default under
// the user's XDG config dir. Missing or malformed config is a *loud* failure:
// the caller is expected to surface the error and exit non-zero, so we never
// silently start a server with no sites.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(), '.config', 'runn', 'lthcs-ops.config.json'
);

function resolveConfigPath() {
  return process.env.LTHCS_OPS_CONFIG || DEFAULT_CONFIG_PATH;
}

class LthcsOpsConfigError extends Error {
  constructor(message, configPath) {
    super(message);
    this.name = 'LthcsOpsConfigError';
    this.configPath = configPath;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}

// Validate one site entry. Returns the field name that's bad, or null if OK.
// Required: host, user, ssh_key_path. Optional (read by specific tools):
//   - vm_name              : virsh domain name for vm_liveness
//   - service_port         : TCP port vm_liveness probes (1..65535)
//   - service_host         : hostname/IP for the probe (defaults to "127.0.0.1"
//                            on the remote, NOT the model)
//   - db_path              : Firebird .fdb path for db_health_check
//   - db_gstat_cmd         : override for the gstat binary (default "gstat")
//   - replication_kick_cmd : remote command (or `{dataset}` template) the
//                            kick_replication tool runs on the site to re-fire
//                            a send. Operator-supplied so the MCP server stays
//                            free of site-specific orchestration policy.
//   - replication_kill_cmd : optional override for kill_stuck_send. When
//                            absent the tool falls back to a safe default
//                            (pgrep `zfs send` matching the dataset → SIGTERM).
//   - services             : optional map keyed by the restart_service closed
//                            enum (firebird, node_red_executor). Each value
//                            must declare `status_cmd` and `restart_cmd`;
//                            `stateful_dataset` is optional and triggers a
//                            pre-mutate ZFS snapshot before the restart for
//                            services that touch on-disk state.
const SERVICE_KEY_RE = /^[a-z][a-z0-9_]*$/;
function badServiceEntry(svc) {
  if (!svc || typeof svc !== 'object' || Array.isArray(svc)) return '<entry>';
  if (!isNonEmptyString(svc.status_cmd))  return 'status_cmd';
  if (!isNonEmptyString(svc.restart_cmd)) return 'restart_cmd';
  if (svc.stateful_dataset !== undefined && !isNonEmptyString(svc.stateful_dataset)) return 'stateful_dataset';
  return null;
}
function badField(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '<entry>';
  if (!isNonEmptyString(entry.host)) return 'host';
  if (!isNonEmptyString(entry.user)) return 'user';
  if (!isNonEmptyString(entry.ssh_key_path)) return 'ssh_key_path';
  if (entry.vm_name              !== undefined && !isNonEmptyString(entry.vm_name))              return 'vm_name';
  if (entry.service_port         !== undefined && !isPort(entry.service_port))                   return 'service_port';
  if (entry.service_host         !== undefined && !isNonEmptyString(entry.service_host))         return 'service_host';
  if (entry.db_path              !== undefined && !isNonEmptyString(entry.db_path))              return 'db_path';
  if (entry.db_gstat_cmd         !== undefined && !isNonEmptyString(entry.db_gstat_cmd))         return 'db_gstat_cmd';
  if (entry.replication_kick_cmd !== undefined && !isNonEmptyString(entry.replication_kick_cmd)) return 'replication_kick_cmd';
  if (entry.replication_kill_cmd !== undefined && !isNonEmptyString(entry.replication_kill_cmd)) return 'replication_kill_cmd';
  if (entry.services !== undefined) {
    if (typeof entry.services !== 'object' || entry.services === null || Array.isArray(entry.services)) {
      return 'services';
    }
    for (const [k, v] of Object.entries(entry.services)) {
      if (!SERVICE_KEY_RE.test(k)) return `services.${k}`;
      const bad = badServiceEntry(v);
      if (bad !== null) return `services.${k}.${bad}`;
    }
  }
  return null;
}

function loadConfig() {
  const configPath = resolveConfigPath();

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LthcsOpsConfigError(
        `config file not found at ${configPath} (set $LTHCS_OPS_CONFIG to override)`,
        configPath,
      );
    }
    throw new LthcsOpsConfigError(
      `cannot read config at ${configPath}: ${err.message}`,
      configPath,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LthcsOpsConfigError(
      `config at ${configPath} is not valid JSON: ${err.message}`,
      configPath,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LthcsOpsConfigError(
      `config at ${configPath} must be a JSON object`,
      configPath,
    );
  }

  const sites = parsed.sites;
  if (sites === undefined || sites === null) {
    throw new LthcsOpsConfigError(
      `config at ${configPath} is missing required "sites" object`,
      configPath,
    );
  }
  if (typeof sites !== 'object' || Array.isArray(sites)) {
    throw new LthcsOpsConfigError(
      `config at ${configPath} "sites" must be an object`,
      configPath,
    );
  }

  for (const [name, entry] of Object.entries(sites)) {
    const bad = badField(entry);
    if (bad !== null) {
      throw new LthcsOpsConfigError(
        `config at ${configPath} site "${name}" is missing or has invalid "${bad}"`,
        configPath,
      );
    }
  }

  return { configPath, sites };
}

module.exports = { loadConfig, LthcsOpsConfigError, resolveConfigPath };
