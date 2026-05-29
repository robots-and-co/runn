'use strict';

// Smoke for the raw-SSH escape hatch (CLIENT_OPS_MCP_DESIGN.md §8.5).
//
// Three things this proves:
//   1. WITH the env flag off, the tool is NOT present in tools/list and a
//      tools/call for it returns "no such tool". (Acceptance criterion #1.)
//   2. WITH the env flag on, the tool IS present, executes against the
//      stubbed ssh, and writes a JSON-lines entry to the dedicated audit log
//      that the env override pointed at. (Acceptance criterion #2.)
//   3. Across both modes, no SECRET value from the site config (host, user,
//      key path) appears in any text the server returned to the model. The
//      audit file is checked separately: it IS allowed to record the
//      resolved host because that file is on-box-only.
//
// We deliberately do NOT touch the CLI's permission-prompt-tool here — same
// scoping as the other lthcs-ops smokes (talking straight to the MCP
// server's stdio bypasses the gate by construction). The "always-allow is
// blocked" guarantee for raw_ssh_exec is enforced by worker/server.js
// (isAlwaysAllowEligible) and exercised separately when server.js is tested.
//
// Run from the repo root:
//   node worker/lthcs-ops-tools/raw-ssh-exec.smoke.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const raw = require('./raw-ssh-exec');

// ── 1. Pure unit checks ──────────────────────────────────────────────────
function unitChecks() {
  const I = raw._internals;

  // sanitiseCommand: any string within bounds is accepted (the whole point
  // is "let me run arbitrary commands"); NUL bytes / empty / too-long are
  // refused — those would just confuse exec without adding any flexibility.
  assert.strictEqual(I.sanitiseCommand('ls -la /var/log'), 'ls -la /var/log');
  assert.strictEqual(I.sanitiseCommand('zfs send -wI foo@a foo@b | ssh recv zfs recv -F bar'),
    'zfs send -wI foo@a foo@b | ssh recv zfs recv -F bar');
  assert.strictEqual(I.sanitiseCommand(''), null);
  assert.strictEqual(I.sanitiseCommand('x\0y'), null);
  assert.strictEqual(I.sanitiseCommand('x'.repeat(I.COMMAND_MAX + 1)), null);
  assert.strictEqual(I.sanitiseCommand(42), null);

  // sanitiseJustification: trimmed-non-empty within bound.
  assert.strictEqual(I.sanitiseJustification('  diagnose stuck send  '), 'diagnose stuck send');
  assert.strictEqual(I.sanitiseJustification(''), null);
  assert.strictEqual(I.sanitiseJustification('   '), null);
  assert.strictEqual(I.sanitiseJustification('y'.repeat(I.JUSTIFICATION_MAX + 1)), null);

  // truncate: passthrough under cap, marker appended over cap.
  assert.deepStrictEqual(I.truncate('hi', 10), { text: 'hi', truncated: false });
  const t = I.truncate('x'.repeat(I.STDOUT_MAX + 50), I.STDOUT_MAX);
  assert.strictEqual(t.truncated, true);
  assert.ok(t.text.length > I.STDOUT_MAX);
  assert.ok(t.text.endsWith('[truncated]'));

  // auditLogPath: env override wins; default goes under $HOME/.claude.
  const saved = process.env[raw.AUDIT_ENV];
  delete process.env[raw.AUDIT_ENV];
  try {
    assert.ok(I.auditLogPath().endsWith(path.join('.claude', 'lthcs-ops-raw-ssh-audit.log')));
    process.env[raw.AUDIT_ENV] = '/tmp/x.log';
    assert.strictEqual(I.auditLogPath(), '/tmp/x.log');
  } finally {
    if (saved === undefined) delete process.env[raw.AUDIT_ENV];
    else process.env[raw.AUDIT_ENV] = saved;
  }

  // isEnabled: env flag must be exactly "1".
  const savedFlag = process.env[raw.ENV_FLAG];
  delete process.env[raw.ENV_FLAG];
  try {
    assert.strictEqual(raw.isEnabled(), false);
    process.env[raw.ENV_FLAG] = '0';      assert.strictEqual(raw.isEnabled(), false);
    process.env[raw.ENV_FLAG] = 'true';   assert.strictEqual(raw.isEnabled(), false);
    process.env[raw.ENV_FLAG] = '1';      assert.strictEqual(raw.isEnabled(), true);
  } finally {
    if (savedFlag === undefined) delete process.env[raw.ENV_FLAG];
    else process.env[raw.ENV_FLAG] = savedFlag;
  }

  // Handler-level defence-in-depth: even if a stale CLI tool cache somehow
  // reached the handler with the flag cleared, it must short-circuit BEFORE
  // any ssh attempt. Mirrors restart_service's enum-guard pattern.
  delete process.env[raw.ENV_FLAG];
  return raw.handler(
    { site: 'A', command: 'whoami', justification: 'flag cleared mid-call' },
    { sites: { A: { host: 'h', user: 'u', ssh_key_path: 'k' } } },
  ).then(r => {
    assert.deepStrictEqual(r, { error: 'raw_ssh_disabled' },
      'raw_ssh_exec handler must short-circuit when env flag is off');
    console.log('OK  unit: sanitisers, truncation, auditLogPath, isEnabled, handler env-guard');
  });
}

// ── 2. MCP smoke with env flag OFF ───────────────────────────────────────
async function smokeDisabled(commonSetup) {
  const { cfgPath, stubDir, sentinelPath, tmpDir } = commonSetup;

  const auditPath = path.join(tmpDir, 'audit-disabled.log');
  const serverPath = path.join(__dirname, '..', 'lthcs-ops.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      LTHCS_OPS_CONFIG: cfgPath,
      // Flag explicitly absent. Clear any inherited value just in case.
      LTHCS_OPS_ALLOW_RAW_SSH: '',
      LTHCS_OPS_RAW_SSH_AUDIT_LOG: auditPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = makeRpc(child);

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });

    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    assert.ok(!names.includes('raw_ssh_exec'),
      `raw_ssh_exec must NOT appear in tools/list when LTHCS_OPS_ALLOW_RAW_SSH is unset (got ${names.join(',')})`);

    // tools/call for it must come back with the server's "no such tool" RPC
    // error — i.e. the tool truly doesn't exist on the wire when disabled.
    const callResp = await rpc('tools/call', {
      name: 'raw_ssh_exec',
      arguments: { site: 'A', command: 'whoami', justification: 'should be unreachable' },
    });
    assert.ok(callResp.error, 'expected tools/call to error when raw_ssh_exec is disabled');
    assert.strictEqual(callResp.error.code, -32601,
      `expected method-not-found-style code, got ${JSON.stringify(callResp.error)}`);

    // And no audit file should have been created — a disabled tool writes
    // nothing anywhere.
    assert.strictEqual(fs.existsSync(auditPath), false,
      `audit log unexpectedly created with flag off: ${auditPath}`);

    // The ssh stub must not have been called for raw_ssh_exec — the only
    // way it could be is if the tool's handler ran. The shared sentinel may
    // contain other entries from previous smoke tests; just check no entry
    // mentions our sentinel command string.
    const calls = fs.existsSync(sentinelPath) ? fs.readFileSync(sentinelPath, 'utf8') : '';
    assert.ok(!calls.includes('whoami-disabled-sentinel'),
      'ssh stub was called while raw_ssh_exec was disabled');

    console.log('OK  e2e (disabled): tool absent from tools/list, tools/call errors, no audit, no ssh');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
  }
}

// ── 3. MCP smoke with env flag ON ────────────────────────────────────────
async function smokeEnabled(commonSetup) {
  const { cfgPath, stubDir, sentinelPath, tmpDir, SECRETS } = commonSetup;

  const auditPath = path.join(tmpDir, 'audit-enabled.log');
  const serverPath = path.join(__dirname, '..', 'lthcs-ops.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      LTHCS_OPS_CONFIG: cfgPath,
      LTHCS_OPS_ALLOW_RAW_SSH: '1',
      LTHCS_OPS_RAW_SSH_AUDIT_LOG: auditPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr.on('data', c => { stderrBuf += c.toString(); });
  const rpc = makeRpc(child);

  const allResultTexts = [];
  async function callTool(name, args) {
    const resp = await rpc('tools/call', { name, arguments: args });
    assert.ok(resp.result && resp.result.content && resp.result.content[0],
      `${name}: missing content (resp=${JSON.stringify(resp)})`);
    const text = resp.result.content[0].text;
    allResultTexts.push(text);
    return JSON.parse(text);
  }

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });

    const list = await rpc('tools/list', {});
    const t = list.result.tools.find(x => x.name === 'raw_ssh_exec');
    assert.ok(t, 'raw_ssh_exec must appear in tools/list when LTHCS_OPS_ALLOW_RAW_SSH=1');
    assert.strictEqual(t.inputSchema.additionalProperties, false,
      'raw_ssh_exec: additionalProperties should be false');
    assert.deepStrictEqual(t.inputSchema.required.slice().sort(), ['command', 'justification', 'site']);
    assert.ok(/escape hatch/i.test(t.description),
      'raw_ssh_exec description must self-identify as the escape hatch (read by the operator/model before calling it)');
    // The CATEGORY metadata is server-internal and must not leak onto the wire.
    assert.ok(!('CATEGORY' in t) && !('category' in t),
      'CATEGORY leaked onto tools/list for raw_ssh_exec');

    // Happy path: stub recognises a marker command and emits a known stdout.
    const ok = await callTool('raw_ssh_exec', {
      site: 'A',
      command: 'RAWSSH-OK-SENTINEL ls -la',
      justification: 'diagnose unexpected file in /var/log (no curated tool covers this)',
    });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(typeof ok.duration_ms, 'number');
    assert.strictEqual(ok.stdout_truncated, false);
    assert.ok(ok.stdout.includes('STDOUT-FROM-STUB'),
      `expected stub stdout to flow back to the model, got: ${ok.stdout}`);

    // Stub records the FULL command in the sentinel log so we can verify the
    // server passed the operator-supplied command through verbatim.
    const calls = fs.readFileSync(sentinelPath, 'utf8').trim().split('\n');
    assert.ok(calls.some(c => c === 'RAWSSH-OK-SENTINEL ls -la'),
      `ssh stub did not record the raw command. calls=\n${calls.join('\n')}`);

    // Non-zero exit: still returns ok:false, NOT an error. A failed command
    // is a normal outcome of an arbitrary exec.
    const failed = await callTool('raw_ssh_exec', {
      site: 'A',
      command: 'RAWSSH-FAIL-SENTINEL',
      justification: 'expected failure for smoke',
    });
    assert.strictEqual(failed.ok, false);
    assert.ok(failed.stderr.includes('STDERR-FROM-STUB'),
      `expected stub stderr to flow back when command fails, got: ${failed.stderr}`);

    // Validation error paths short-circuit BEFORE any ssh attempt.
    const badSite = await callTool('raw_ssh_exec', {
      site: 'NOPE', command: 'ls', justification: 'should refuse',
    });
    assert.deepStrictEqual(badSite, { error: 'unknown_site' });
    const badCmd = await callTool('raw_ssh_exec', {
      site: 'A', command: 'x\0y', justification: 'has NUL byte',
    });
    assert.deepStrictEqual(badCmd, { error: 'invalid_command' });
    const badJust = await callTool('raw_ssh_exec', {
      site: 'A', command: 'ls', justification: '   ',
    });
    assert.deepStrictEqual(badJust, { error: 'invalid_justification' });

    // Truncation: stub emits >STDOUT_MAX bytes for a large-output marker.
    const big = await callTool('raw_ssh_exec', {
      site: 'A', command: 'RAWSSH-BIG-OUTPUT-SENTINEL',
      justification: 'force truncation path',
    });
    assert.strictEqual(big.ok, true);
    assert.strictEqual(big.stdout_truncated, true);
    assert.ok(big.stdout.endsWith('[truncated]'));

    // ── Audit log: the headline guarantee of §8.5 ──
    // Every successful invocation writes BOTH a start and an end entry; the
    // two error paths that reached the handler (badSite is unknown_site —
    // also short-circuits before audit; bigOutput counts as a successful
    // call). We assert: file exists; each line parses as JSON; each entry
    // carries site label, justification, tool name; the resolved host is
    // included on the start record (this is the file the model never sees,
    // so recording the host here is correct).
    assert.ok(fs.existsSync(auditPath), `audit log not created: ${auditPath}`);
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(auditLines.length >= 6,
      `expected at least 6 audit entries (3 calls × {start,end}), got ${auditLines.length}`);
    for (const e of auditLines) {
      assert.strictEqual(e.tool, 'raw_ssh_exec', 'audit entry has wrong tool field');
      assert.strictEqual(e.site, 'A', 'audit entry has wrong site label');
      assert.ok(typeof e.justification === 'string' && e.justification.length > 0,
        'audit entry missing justification');
      assert.ok(['start', 'end'].includes(e.phase), `audit entry has unknown phase: ${e.phase}`);
    }
    const starts = auditLines.filter(e => e.phase === 'start');
    const ends   = auditLines.filter(e => e.phase === 'end');
    assert.strictEqual(starts.length, ends.length,
      `start/end audit entries imbalanced: ${starts.length} vs ${ends.length}`);
    // Start entries record the resolved host + command verbatim — the file
    // is on-box-only, so this is exactly the forensic detail the operator
    // needs after the fact.
    assert.ok(starts.some(e => e.resolved_host === SECRETS.HOST),
      'audit start entries must record the resolved host (file is on-box-only)');
    assert.ok(starts.some(e => e.command === 'RAWSSH-OK-SENTINEL ls -la'),
      'audit start entries must record the full command');
    // End entries carry exit/timing for the forensic chain.
    for (const e of ends) {
      assert.strictEqual(typeof e.ok, 'boolean');
      assert.strictEqual(typeof e.duration_ms, 'number');
    }

    // ── Cardinal invariant: NO secret config value appears in any tool
    // result the server sent back to the model. The audit file is exempt
    // (it's the on-box record), but the wire is not.
    const blob = allResultTexts.join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!blob.includes(v), `result text leaked SECRETS.${k} ("${v}")`);
    }
    // Same check on stderr (we log site label + justification only there).
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!stderrBuf.includes(v), `stderr leaked SECRETS.${k} ("${v}")`);
    }
    // The MUTATING category audit line must have fired (registry annotates
    // raw_ssh_exec as 'mutating' for exactly this reason).
    assert.ok(/MUTATING tool=raw_ssh_exec/.test(stderrBuf),
      `expected MUTATING audit line for raw_ssh_exec on stderr, got:\n${stderrBuf}`);
    // And the dedicated RAW_SSH_EXEC audit line on top — the second visible
    // signal that the escape hatch was used.
    assert.ok(/RAW_SSH_EXEC site="A"/.test(stderrBuf),
      `expected dedicated RAW_SSH_EXEC stderr audit line, got:\n${stderrBuf}`);

    console.log('OK  e2e (enabled): tools/list contains raw_ssh_exec, executes, returns stdout');
    console.log('OK  e2e (enabled): dedicated audit log written with start+end entries');
    console.log('OK  e2e (enabled): zero secret leakage in results or stderr');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
  }

  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server stderr]\n${stderrBuf}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────
function makeRpc(child) {
  let nextId = 1;
  const pending = new Map();
  let lineBuf = '';
  child.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });
  return function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }
      }, 10000);
    });
  };
}

function setupCommon() {
  const SECRETS = {
    HOST: 'SECRET-HOST-203-0-113-77',
    USER: 'SECRET-USER-zoperator',
    KEY:  '/home/waz/SECRET-KEY-PATH/id_rsa',
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-raw-smoke-'));
  const cfgPath = path.join(tmpDir, 'lthcs-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: { host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY },
    },
  }));

  const stubDir = path.join(tmpDir, 'bin');
  const sentinelPath = path.join(tmpDir, 'ssh-calls.log');
  fs.mkdirSync(stubDir);
  // ssh stub: records the remote command, then dispatches by sentinel prefix.
  // - RAWSSH-OK-SENTINEL → exit 0 with a known stdout marker
  // - RAWSSH-FAIL-SENTINEL → exit 1 with a known stderr marker
  // - RAWSSH-BIG-OUTPUT-SENTINEL → emit > STDOUT_MAX (4096) bytes
  // Anything else exits 2 so we'd notice an unexpected ssh shape.
  const STDOUT_MAX = raw._internals.STDOUT_MAX;
  const sshStub = `#!/usr/bin/env node
const fs = require('fs');
const remote = process.argv[process.argv.length - 1] || '';
fs.appendFileSync(${JSON.stringify(sentinelPath)}, remote + '\\n');
if (remote.startsWith('RAWSSH-OK-SENTINEL')) {
  process.stdout.write('STDOUT-FROM-STUB ok\\n');
  process.exit(0);
}
if (remote.startsWith('RAWSSH-FAIL-SENTINEL')) {
  process.stderr.write('STDERR-FROM-STUB nope\\n');
  process.exit(1);
}
if (remote.startsWith('RAWSSH-BIG-OUTPUT-SENTINEL')) {
  process.stdout.write('y'.repeat(${STDOUT_MAX + 200}));
  process.exit(0);
}
process.stderr.write('fake-ssh: unexpected remote cmd: ' + remote + '\\n');
process.exit(2);
`;
  fs.writeFileSync(path.join(stubDir, 'ssh'), sshStub, { mode: 0o755 });

  return { tmpDir, cfgPath, stubDir, sentinelPath, SECRETS };
}

(async () => {
  await unitChecks();
  const common = setupCommon();
  try {
    await smokeDisabled(common);
    await smokeEnabled(common);
  } finally {
    fs.rmSync(common.tmpDir, { recursive: true, force: true });
  }
  console.log('all raw-ssh-exec smoke checks passed');
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
