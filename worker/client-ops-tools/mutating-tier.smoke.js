'use strict';

// Smoke for the mutating tier added in mcp-task 05:
//   create_snapshot (and the shared _snapshot.js pre-hook helper).
//
// Same two-layer shape as the read-only tier smoke
// (worker/client-ops-tools/read-only-tier.smoke.js):
//   1. Pure unit checks on sanitiser + tag builder + helper-error paths,
//      no network and no ssh subprocess.
//   2. One MCP server subprocess driven over stdio. PATH is shadowed with a
//      Node stub that pretends to be ssh, records the remote command, and
//      either succeeds or fails on demand. We assert the response shape, the
//      command shape, and — the cardinal invariant — that NO secret value
//      from the site config appears in anything the server sends back.
//
// Note on the approval gate: the CLI's --permission-prompt-tool runs *before*
// the tool reaches the server, so a smoke test that talks straight to the
// server's stdio bypasses the gate by construction. This is the right scope
// for a server-side smoke; the gate's own behaviour is covered by the
// permission-prompt server (worker/mcp-permission.js) and the worker HTTP
// route that backs it. What we DO verify here is that:
//   - create_snapshot is exposed under tools/list,
//   - its handler runs the expected `zfs snapshot` command,
//   - the result schema is the sanitised one (tag + created, no host/path),
//   - the registry's CATEGORY metadata stays server-internal (not on the wire).
//
// Run from the repo root:
//   node worker/client-ops-tools/mutating-tier.smoke.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const snap   = require('./_snapshot');
const create = require('./create-snapshot');

// ── 1. Pure unit checks ──────────────────────────────────────────────────
function unitChecks() {
  // sanitiseDataset: same charset as the read-only tier.
  assert.strictEqual(snap._internals.sanitiseDataset('pool/winvm'), 'pool/winvm');
  assert.strictEqual(snap._internals.sanitiseDataset('a.b-c_d/e'), 'a.b-c_d/e');
  assert.strictEqual(snap._internals.sanitiseDataset(''),       null);
  assert.strictEqual(snap._internals.sanitiseDataset('x; rm /'), null);
  assert.strictEqual(snap._internals.sanitiseDataset('x y'),     null);
  assert.strictEqual(snap._internals.sanitiseDataset(42),        null);

  // buildTag: deterministic when `now` is provided, prefixed convention.
  assert.strictEqual(snap._internals.buildTag(1700000000), 'runn-pre-mutate-1700000000');
  assert.strictEqual(snap._internals.buildTag(1700000000.9), 'runn-pre-mutate-1700000000');
  const auto = snap._internals.buildTag();
  assert.ok(/^runn-pre-mutate-\d{9,}$/.test(auto), `auto tag malformed: ${auto}`);

  // createPreMutateSnapshot rejects bad sites / datasets before any ssh.
  return Promise.all([
    snap.createPreMutateSnapshot(null, 'pool/winvm').then(r => {
      assert.deepStrictEqual(r, { ok: false, error: 'unknown_site' });
    }),
    snap.createPreMutateSnapshot({ host: 'h', user: 'u', ssh_key_path: 'k' }, 'foo; bad').then(r => {
      assert.deepStrictEqual(r, { ok: false, error: 'invalid_dataset' });
    }),
    // create_snapshot tool: sanitiseReason
    Promise.resolve().then(() => {
      assert.strictEqual(create._internals.sanitiseReason('   '), null);
      assert.strictEqual(create._internals.sanitiseReason(''), null);
      assert.strictEqual(create._internals.sanitiseReason('x'.repeat(501)), null);
      assert.strictEqual(create._internals.sanitiseReason('  pre-migration insurance  '),
        'pre-migration insurance');
    }),
  ]).then(() => {
    console.log('OK  unit: snapshot helper sanitisers + tag builder + reason sanitiser');
  });
}

// ── 2. End-to-end MCP smoke against a stubbed ssh ────────────────────────
async function mcpSmoke() {
  const SECRETS = {
    HOST: 'SECRET-HOST-203-0-113-77',
    USER: 'SECRET-USER-zoperator',
    KEY:  '/home/waz/SECRET-KEY-PATH/id_rsa',
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-mut-smoke-'));
  const cfgPath = path.join(tmpDir, 'client-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: { host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY },
    },
  }));

  // Stub ssh: record each invocation and succeed for `zfs snapshot`. We need
  // the stub to dump the full remote command into a sentinel file so the
  // test can assert what was sent (the tool result deliberately doesn't echo
  // it). Failure mode: a "BADDS" prefix triggers a non-zero exit so we can
  // exercise the snapshot_create_failed path.
  const stubDir = path.join(tmpDir, 'bin');
  const sentinelPath = path.join(tmpDir, 'ssh-calls.log');
  fs.mkdirSync(stubDir);
  const sshStub = `#!/usr/bin/env node
const fs = require('fs');
const remote = process.argv[process.argv.length - 1] || '';
fs.appendFileSync(${JSON.stringify(sentinelPath)}, remote + '\\n');
if (remote.startsWith('zfs snapshot BADDS')) {
  process.stderr.write('cannot create snapshot\\n');
  process.exit(1);
}
if (remote.startsWith('zfs snapshot ')) {
  process.exit(0);
}
process.stderr.write('fake-ssh: unexpected remote cmd: ' + remote + '\\n');
process.exit(2);
`;
  fs.writeFileSync(path.join(stubDir, 'ssh'), sshStub, { mode: 0o755 });

  const serverPath = path.join(__dirname, '..', 'client-ops.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      CLIENT_OPS_CONFIG: cfgPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stderr.on('data', c => { stderrBuf += c.toString(); });

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
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }
    }, 10000);
  });

  const allResultTexts = [];
  function callTool(name, args) {
    return rpc('tools/call', { name, arguments: args }).then(resp => {
      assert.ok(resp.result && resp.result.content && resp.result.content[0],
        `${name}: missing content`);
      const text = resp.result.content[0].text;
      allResultTexts.push(text);
      return JSON.parse(text);
    });
  }

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });

    // tools/list must include create_snapshot, but its CATEGORY metadata
    // must NOT leak onto the wire — it's a server-internal label.
    const list = await rpc('tools/list', {});
    const created = list.result.tools.find(t => t.name === 'create_snapshot');
    assert.ok(created, 'create_snapshot missing from tools/list');
    assert.strictEqual(created.inputSchema.required.sort().join(','), 'dataset,reason,site');
    assert.strictEqual(created.inputSchema.additionalProperties, false);
    assert.ok(!('CATEGORY' in created), 'CATEGORY leaked into tools/list entry');
    assert.ok(!('category' in created), 'category leaked into tools/list entry');

    // Happy path: snapshot succeeds, result has tag + created, no host/path.
    const ok = await callTool('create_snapshot', {
      site: 'A', dataset: 'pool0/winvm',
      reason: 'pre-migration insurance for smoke test',
    });
    assert.strictEqual(ok.ok, true);
    assert.ok(/^runn-pre-mutate-\d{9,}$/.test(ok.tag), `tag malformed: ${ok.tag}`);
    assert.ok(/T.*Z$/.test(ok.created), `created not ISO-8601: ${ok.created}`);

    // The stub recorded the exact remote command. It must be `zfs snapshot
    // <dataset>@<tag>` — nothing more, nothing less.
    const calls = fs.readFileSync(sentinelPath, 'utf8').trim().split('\n');
    assert.strictEqual(calls.length, 1, `expected 1 ssh call, got ${calls.length}`);
    assert.strictEqual(calls[0], `zfs snapshot pool0/winvm@${ok.tag}`);

    // Invalid reason → no ssh call, structured error.
    const badReason = await callTool('create_snapshot', {
      site: 'A', dataset: 'pool0/winvm', reason: '   ',
    });
    assert.deepStrictEqual(badReason, { error: 'invalid_reason' });

    // Invalid dataset → no ssh call, structured error.
    const badDs = await callTool('create_snapshot', {
      site: 'A', dataset: 'foo; rm -rf /', reason: 'ok',
    });
    assert.deepStrictEqual(badDs, { error: 'invalid_dataset' });

    // Failure path: dataset starts with BADDS → stub exits 1.
    const fail = await callTool('create_snapshot', {
      site: 'A', dataset: 'BADDSpool/x', reason: 'expected to fail',
    });
    assert.deepStrictEqual(fail, { error: 'snapshot_create_failed' });

    const callsAfter = fs.readFileSync(sentinelPath, 'utf8').trim().split('\n');
    assert.strictEqual(callsAfter.length, 2,
      `expected 2 ssh calls after bad-arg rejections + failing call, got ${callsAfter.length}`);

    // Cardinal property: no real config secret appears in any tool result.
    const blob = allResultTexts.join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!blob.includes(v), `result text leaked SECRETS.${k} ("${v}")`);
    }

    // The MUTATING audit line must have fired on stderr at least once. That
    // line stays on box (it's process.stderr from the server subprocess) but
    // it must not contain a config secret either.
    assert.ok(/MUTATING tool=create_snapshot/.test(stderrBuf),
      `expected MUTATING audit line on stderr, got:\n${stderrBuf}`);
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!stderrBuf.includes(v), `stderr audit leaked SECRETS.${k} ("${v}")`);
    }

    console.log('OK  e2e: create_snapshot end-to-end + audit + zero secret leakage');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server stderr]\n${stderrBuf}\n`);
}

(async () => {
  await unitChecks();
  await mcpSmoke();
  console.log('all mutating tier smoke checks passed');
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
