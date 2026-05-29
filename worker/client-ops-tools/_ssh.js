'use strict';

// Shared SSH/exec primitives for the curated client-ops tools.
//
// One rule binds every consumer of this module: stdout/stderr returned by
// `run()` MUST NOT be propagated into a tool result the model receives.
// Parsers extract typed fields and discard the prose, including error
// messages — `execFile`'s err.message can embed the full command line
// (key path, user, host) which is exactly what the boundary exists to
// prevent leaking.

const { execFile } = require('child_process');

function sshBaseArgs({ host, user, ssh_key_path }) {
  return [
    '-i', ssh_key_path,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'IdentitiesOnly=yes',
    `${user}@${host}`,
  ];
}

// Wrap a string in single quotes safely for a POSIX remote shell. A literal
// single quote is rendered as `'\''` (close, escaped, reopen). The result
// is intended for paths read from the local config — strings the model never
// supplies — but the quoting still defends against an operator typo from
// becoming a remote-shell injection.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Run a command via execFile (no local shell). Resolves with
// {ok, stdout, stderr} — caller is responsible for parsing and discarding
// the prose before returning anything to the model.
function run(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      cmd, args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}

// Convenience: build the ssh argv for a site and run a remote command string.
// The remote command is sent as a single positional argument to ssh, which
// re-executes it under the remote login shell — so callers that interpolate
// any operator-supplied value must quote it with `shellQuote` first.
function runSsh(site, remoteCmd, { timeoutMs }) {
  return run('ssh', [...sshBaseArgs(site), remoteCmd], { timeoutMs });
}

module.exports = { sshBaseArgs, shellQuote, run, runSsh };
