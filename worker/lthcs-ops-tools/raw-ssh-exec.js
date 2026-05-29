'use strict';

// MUTATING lthcs-ops tool: raw_ssh_exec({ site, command, justification })
//
// THE EXPLICIT ESCAPE HATCH.
//
// CLIENT_OPS_MCP_DESIGN.md §2 closes with the honest tradeoff: a narrow
// curated boundary is safe precisely because it is narrow. Genuinely novel,
// unscripted work either gets a new tool authored first, or falls back to a
// raw-SSH path that re-incurs both fears (data leakage AND action liability)
// and goes through approval. This tool IS that fallback — explicit, opt-in,
// and instrumented so its use is impossible to miss after the fact. §8.5
// records this as the decided policy. Per-client scoping (§8.7) means each
// client's server has its OWN allow flag and audit log, so opting one
// client in never silently arms the hatch for another.
//
// Three controls layer on top of the standard mutating-tier flow, all
// belt-and-braces — any one of them blocks an accidental call:
//
//   1. Disabled by default. The tool is only registered into tools/list when
//      env LTHCS_OPS_ALLOW_RAW_SSH=1 is set at server boot, AND the handler
//      re-checks the flag at call time (defence-in-depth against a stale CLI
//      tool cache reaching us after the flag was cleared).
//
//   2. Visibly distinct approval. The Runn frontend renders the permission
//      card in a danger palette and suppresses the "Always allow" button for
//      this tool name, and worker/server.js refuses to persist or apply an
//      always-allow rule for it. The operator must affirmatively click Allow
//      every single time — there is no path to blanket approval.
//
//   3. Dedicated audit channel. Every invocation is appended (pre- and
//      post-execution) to a separate JSON-lines log file in addition to the
//      session .jsonl. The path is `$LTHCS_OPS_RAW_SSH_AUDIT_LOG` or by
//      default `$HOME/.claude/lthcs-ops-raw-ssh-audit.log`. Grepping that
//      single file gives a clean answer to "when did the AI ever fall back
//      to raw SSH on lthcs and why?" without trawling per-session transcripts.
//
// Result schema (success or non-zero exit; the latter is not an error here —
// a failed command is a normal outcome and we surface it):
//   { ok:        boolean,         // true iff ssh exited 0
//     duration_ms: number,
//     stdout_truncated: boolean,
//     stderr_truncated: boolean,
//     stdout:     string,         // up to STDOUT_MAX chars
//     stderr:     string }        // up to STDERR_MAX chars
//
// Errors (no ssh attempt happens):
//   { error: "raw_ssh_disabled" | "unknown_site" |
//            "invalid_command" | "invalid_justification" |
//            "audit_log_failed" }
//
// Deliberately NOT returned: the resolved host, ssh user, key path, or any
// other config field. The model supplied `site="A"`; everything else is
// opaque on the wire.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sshBaseArgs, run } = require('./_ssh');

const NAME = 'raw_ssh_exec';
const CATEGORY = 'mutating';
const ENV_FLAG = 'LTHCS_OPS_ALLOW_RAW_SSH';
const AUDIT_ENV = 'LTHCS_OPS_RAW_SSH_AUDIT_LOG';

const DESCRIPTION =
  'ESCAPE HATCH — run an arbitrary command over SSH on a configured site. ' +
  'This bypasses the curated boundary and SHOULD ONLY be used for genuinely ' +
  'novel work no curated tool covers. Disabled by default; the operator ' +
  'opts in per Runn invocation via env LTHCS_OPS_ALLOW_RAW_SSH=1. Every ' +
  'call requires approval (no "always allow") and is logged to a dedicated ' +
  'audit file in addition to the session transcript. Justification is ' +
  'mandatory and recorded. Stdout and stderr are returned to the caller, ' +
  'truncated; the resolved host/user/key are not.';

// Mirrors the mutating tier's per-tool input shapes (closed site enum, bounded
// strings). Command and justification are bounded so a runaway model can't
// dump a megabyte of payload through the approval prompt unnoticed.
const COMMAND_MAX = 8192;
const JUSTIFICATION_MAX = 1000;
const STDOUT_MAX = 4096;
const STDERR_MAX = 2048;
const SSH_TIMEOUT_MS = 120000;

function isEnabled() {
  return process.env[ENV_FLAG] === '1';
}

function inputSchema(siteNames) {
  return {
    type: 'object',
    properties: {
      site:          { enum: siteNames },
      command:       { type: 'string', minLength: 1, maxLength: COMMAND_MAX },
      justification: { type: 'string', minLength: 1, maxLength: JUSTIFICATION_MAX },
    },
    required: ['site', 'command', 'justification'],
    additionalProperties: false,
  };
}

function sanitiseCommand(s) {
  if (typeof s !== 'string') return null;
  if (!s.length || s.length > COMMAND_MAX) return null;
  // No charset filter — the whole point is "let me run an arbitrary command".
  // We refuse only obvious framing failures (NUL, etc) that confuse exec.
  if (s.indexOf('\0') >= 0) return null;
  return s;
}

function sanitiseJustification(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.length || trimmed.length > JUSTIFICATION_MAX) return null;
  return trimmed;
}

function auditLogPath() {
  return process.env[AUDIT_ENV] || path.join(
    os.homedir(), '.claude', 'lthcs-ops-raw-ssh-audit.log',
  );
}

// Append one JSON line. The audit log is the on-box forensic record; we
// include the resolved host here (not just the site label) because the
// operator may need to correlate which physical box was touched — this file
// never reaches the model. Caller-supplied directories under $HOME are
// auto-created on first write.
function appendAudit(entry) {
  const p = auditLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
}

function truncate(s, max) {
  const str = String(s || '');
  if (str.length <= max) return { text: str, truncated: false };
  return { text: str.slice(0, max) + '\n…[truncated]', truncated: true };
}

async function handler(args, { sites }) {
  // (1) Re-check the env flag here too. tools/list filters by isEnabled() at
  // boot, but a long-lived CLI tool cache could in theory call us after the
  // flag was cleared. Refuse explicitly with the same error name the model
  // would see for any disabled tool — no shell attempt, no audit entry.
  if (!isEnabled()) return { error: 'raw_ssh_disabled' };

  const siteLabel = args && args.site;
  const site = sites[siteLabel];
  if (!site) return { error: 'unknown_site' };

  const command = sanitiseCommand(args && args.command);
  if (!command) return { error: 'invalid_command' };

  const justification = sanitiseJustification(args && args.justification);
  if (!justification) return { error: 'invalid_justification' };

  // (2) Pre-execution audit BEFORE the network call so a crash mid-run still
  // leaves a record that we *intended* to run this command and why. If the
  // file write itself fails, refuse to proceed — the dedicated channel is
  // the headline guarantee of this escape hatch and we will not silently
  // drop entries.
  const startedAt = new Date().toISOString();
  try {
    appendAudit({
      phase: 'start', ts: startedAt, tool: NAME,
      site: siteLabel, resolved_host: site.host, resolved_user: site.user,
      justification, command,
    });
  } catch (err) {
    process.stderr.write(
      `lthcs-ops: raw_ssh_exec audit append failed: ${err && err.message}\n`
    );
    return { error: 'audit_log_failed' };
  }

  // Standard mutating-tier stderr audit line. Site label is abstract;
  // justification is operator-readable. The full command and resolved host
  // live only in the dedicated audit file.
  process.stderr.write(
    `lthcs-ops: RAW_SSH_EXEC site=${JSON.stringify(siteLabel)} ` +
    `justification=${JSON.stringify(justification)}\n`
  );

  const t0 = Date.now();
  const res = await run('ssh', [...sshBaseArgs(site), command], { timeoutMs: SSH_TIMEOUT_MS });
  const duration_ms = Date.now() - t0;

  const stdoutT = truncate(res.stdout, STDOUT_MAX);
  const stderrT = truncate(res.stderr, STDERR_MAX);

  // (2 cont.) Post-execution audit: the outcome of the same call we logged at
  // start. Best-effort — we don't want a logging failure here to hide a real
  // result from the operator, who can still see what happened via the model's
  // returned payload + the session jsonl.
  try {
    appendAudit({
      phase: 'end', ts: new Date().toISOString(), tool: NAME,
      site: siteLabel, justification,
      ok: !!res.ok, duration_ms,
      stdout_bytes: res.stdout.length, stderr_bytes: res.stderr.length,
    });
  } catch (err) {
    process.stderr.write(
      `lthcs-ops: raw_ssh_exec audit (end) failed: ${err && err.message}\n`
    );
  }

  return {
    ok: !!res.ok,
    duration_ms,
    stdout_truncated: stdoutT.truncated,
    stderr_truncated: stderrT.truncated,
    stdout: stdoutT.text,
    stderr: stderrT.text,
  };
}

module.exports = {
  NAME, CATEGORY, DESCRIPTION, inputSchema, handler, isEnabled,
  ENV_FLAG, AUDIT_ENV,
  _internals: {
    sanitiseCommand, sanitiseJustification,
    auditLogPath, appendAudit, truncate,
    STDOUT_MAX, STDERR_MAX, COMMAND_MAX, JUSTIFICATION_MAX,
  },
};
