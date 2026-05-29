'use strict';

// Local-only site/secret config loader for the client-ops MCP boundary.
//
// The contract (see CLIENT_OPS_MCP_DESIGN.md §3, §8.2): the model never sees
// real hostnames/users/keys. The server resolves the abstract site label
// ("A", "B", "RECEIVER", …) to a concrete `{ host, user, ssh_key_path }`
// here, server-side, and that mapping never leaves the worker container.
//
// The path is read from $CLIENT_OPS_CONFIG (mirroring how
// worker/mcp-permission.js reads its token from env), with a default under
// the user's XDG config dir. Missing or malformed config is a *loud* failure:
// the caller is expected to surface the error and exit non-zero, so we never
// silently start a server with no sites.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(), '.config', 'runn', 'client-ops.config.json'
);

function resolveConfigPath() {
  return process.env.CLIENT_OPS_CONFIG || DEFAULT_CONFIG_PATH;
}

class ClientOpsConfigError extends Error {
  constructor(message, configPath) {
    super(message);
    this.name = 'ClientOpsConfigError';
    this.configPath = configPath;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Validate one site entry. Returns the field name that's bad, or null if OK.
function badField(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '<entry>';
  if (!isNonEmptyString(entry.host)) return 'host';
  if (!isNonEmptyString(entry.user)) return 'user';
  if (!isNonEmptyString(entry.ssh_key_path)) return 'ssh_key_path';
  return null;
}

function loadConfig() {
  const configPath = resolveConfigPath();

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ClientOpsConfigError(
        `config file not found at ${configPath} (set $CLIENT_OPS_CONFIG to override)`,
        configPath,
      );
    }
    throw new ClientOpsConfigError(
      `cannot read config at ${configPath}: ${err.message}`,
      configPath,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ClientOpsConfigError(
      `config at ${configPath} is not valid JSON: ${err.message}`,
      configPath,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClientOpsConfigError(
      `config at ${configPath} must be a JSON object`,
      configPath,
    );
  }

  const sites = parsed.sites;
  if (sites === undefined || sites === null) {
    throw new ClientOpsConfigError(
      `config at ${configPath} is missing required "sites" object`,
      configPath,
    );
  }
  if (typeof sites !== 'object' || Array.isArray(sites)) {
    throw new ClientOpsConfigError(
      `config at ${configPath} "sites" must be an object`,
      configPath,
    );
  }

  for (const [name, entry] of Object.entries(sites)) {
    const bad = badField(entry);
    if (bad !== null) {
      throw new ClientOpsConfigError(
        `config at ${configPath} site "${name}" is missing or has invalid "${bad}"`,
        configPath,
      );
    }
  }

  return { configPath, sites };
}

module.exports = { loadConfig, ClientOpsConfigError, resolveConfigPath };
