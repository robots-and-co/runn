'use strict';

// Standalone smoke for zfs_replication_status. Run from repo root:
//   node worker/client-ops-tools/zfs-replication-status.smoke.js
//
// Two layers of coverage:
//   1. Pure parsers and the dataset whitelist (no network, no ssh).
//   2. The MCP server itself (worker/client-ops.js) launched as a subprocess
//      with PATH stubbed so that `ssh` is a deterministic local script. We
//      drive a real tools/list + tools/call over its stdio and assert the
//      response shape — in particular that it contains no host/user/key
//      string from the site config.
//
// No real network or real ZFS host is required.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tool = require('./zfs-replication-status');
const { sanitiseDataset, parseHealth, parseLatestSnapshot } = tool._internals;

// ── 1. Pure parser / sanitiser checks ────────────────────────────────────
function unitChecks() {
  // Dataset whitelist.
  assert.strictEqual(sanitiseDataset('pool0/winvm'), 'pool0/winvm');
  assert.strictEqual(sanitiseDataset('foo.bar-baz_1'), 'foo.bar-baz_1');
  assert.strictEqual(sanitiseDataset('foo; rm -rf /'), null);
  assert.strictEqual(sanitiseDataset('foo bar'), null);
  assert.strictEqual(sanitiseDataset('$(id)'), null);
  assert.strictEqual(sanitiseDataset(''), null);
  assert.strictEqual(sanitiseDataset(null), null);

  // Health parsing.
  assert.deepStrictEqual(parseHealth('all pools are healthy\n'), { healthy: true, notes: [] });
  const degraded =
    '  pool: pool0\n state: DEGRADED\nstatus: One or more devices ...\n';
  const h = parseHealth(degraded);
  assert.strictEqual(h.healthy, false);
  const scrubbing =
    '  pool: pool0\n state: ONLINE\n  scan: scrub in progress since ...\nall pools are healthy\n';
  const s = parseHealth(scrubbing);
  assert.strictEqual(s.healthy, true);
  assert.deepStrictEqual(s.notes, ['scrub_in_progress']);

  // Snapshot parsing.
  const stdout = [
    '1700000000\tpool0/winvm@snap-a',
    '1700003600\tpool0/winvm@snap-b',
    '1700007200\tpool0/winvm@snap-c',
  ].join('\n') + '\n';
  const parsed = parseLatestSnapshot(stdout);
  assert.strictEqual(parsed.epoch, 1700007200);
  assert.strictEqual(parsed.count, 3);
  assert.strictEqual(parseLatestSnapshot(''), null);
  assert.strictEqual(parseLatestSnapshot('garbage\n'), null);

  console.log('OK  unit: sanitisation + parsers');
}

// ── 2. End-to-end MCP smoke against stubbed ssh ──────────────────────────
async function mcpSmoke() {
  // Stub config: secret values we want to make sure NEVER leak into the
  // JSON-RPC response sent back to the model.
  const SECRET_HOST = 'SECRET-HOST-203-0-113-77';
  const SECRET_USER = 'SECRET-USER-zoperator';
  const SECRET_KEY  = '/home/waz/SECRET-KEY-PATH/id_rsa';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-ops-smoke-'));
  const cfgPath = path.join(tmpDir, 'client-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: { host: SECRET_HOST, user: SECRET_USER, ssh_key_path: SECRET_KEY },
    },
  }));

  // Build a fake `ssh` on PATH. It inspects the last arg (the remote command)
  // and emits canned ZFS / zpool output. We use a directory prepended to PATH
  // so the real ssh isn't touched.
  const stubDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(stubDir);
  const fakeEpoch = Math.floor(Date.now() / 1000) - 3600; // 1h ago
  const sshStub = `#!/usr/bin/env node
const remote = process.argv[process.argv.length - 1] || '';
if (remote.startsWith('zpool status')) {
  process.stdout.write('all pools are healthy\\n');
  process.exit(0);
}
if (remote.startsWith('zfs list')) {
  process.stdout.write('${fakeEpoch - 7200}\\tpool0/winvm@old\\n');
  process.stdout.write('${fakeEpoch}\\tpool0/winvm@new\\n');
  process.exit(0);
}
process.stderr.write('fake-ssh: unknown remote cmd: ' + remote + '\\n');
process.exit(2);
`;
  const sshStubPath = path.join(stubDir, 'ssh');
  fs.writeFileSync(sshStubPath, sshStub, { mode: 0o755 });

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

  // Promise-based JSON-RPC over stdio.
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

  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    assert.ok(init.result && init.result.serverInfo, 'initialize returned no serverInfo');

    const list = await rpc('tools/list', {});
    assert.ok(Array.isArray(list.result.tools), 'tools/list should return an array');
    const t = list.result.tools.find(x => x.name === 'zfs_replication_status');
    assert.ok(t, 'zfs_replication_status not registered');
    assert.deepStrictEqual(t.inputSchema.properties.site.enum, ['A']);

    // Healthy path with a dataset → expect latest_snapshot + lag_seconds.
    const call = await rpc('tools/call', {
      name: 'zfs_replication_status',
      arguments: { site: 'A', dataset: 'pool0/winvm' },
    });
    assert.ok(call.result && call.result.content && call.result.content[0], 'tool result missing content');
    const text = call.result.content[0].text;
    const payload = JSON.parse(text);
    assert.strictEqual(payload.pool, 'primary');
    assert.strictEqual(payload.healthy, true);
    assert.ok(typeof payload.latest_snapshot === 'string' && /T.*Z$/.test(payload.latest_snapshot), 'latest_snapshot not ISO-8601');
    assert.ok(Number.isInteger(payload.lag_seconds) && payload.lag_seconds >= 0, 'lag_seconds bad');

    // The cardinal property: no secret values appear in the serialised text
    // the model would receive.
    for (const secret of [SECRET_HOST, SECRET_USER, SECRET_KEY, 'pool0', 'winvm', '@snap', '@new', '@old']) {
      assert.ok(!text.includes(secret), `result text leaked "${secret}": ${text}`);
    }

    // Rejected dataset (shell metacharacters) → invalid_dataset, no ssh call.
    const bad = await rpc('tools/call', {
      name: 'zfs_replication_status',
      arguments: { site: 'A', dataset: 'foo; echo OWNED' },
    });
    const badPayload = JSON.parse(bad.result.content[0].text);
    assert.strictEqual(badPayload.error, 'invalid_dataset');

    // No-dataset call → health only, no snapshot keys.
    const healthOnly = await rpc('tools/call', {
      name: 'zfs_replication_status',
      arguments: { site: 'A' },
    });
    const hop = JSON.parse(healthOnly.result.content[0].text);
    assert.strictEqual(hop.healthy, true);
    assert.strictEqual(hop.pool, 'primary');
    assert.ok(!('latest_snapshot' in hop) && !('lag_seconds' in hop));

    console.log('OK  e2e: tools/list + tools/call against stubbed ssh');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // Surface server stderr if anything went sideways (helpful when iterating).
  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server stderr]\n${stderrBuf}\n`);
}

(async () => {
  unitChecks();
  await mcpSmoke();
  console.log('all client-ops zfs_replication_status smoke checks passed');
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
