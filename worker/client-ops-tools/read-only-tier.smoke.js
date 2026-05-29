'use strict';

// Smoke for the read-only tier added in mcp-task 04:
//   zpool_status, list_snapshots, receiver_free_space,
//   vm_liveness, db_health_check.
//
// Two layers, like worker/client-ops-tools/zfs-replication-status.smoke.js:
//   1. Pure parsers exercised directly (no network, no ssh).
//   2. One MCP server subprocess driven over stdio. PATH is shadowed with a
//      Node stub that pretends to be ssh and emits canned ZFS / virsh /
//      gstat output. We assert the response shape and — the cardinal
//      invariant — that NO secret value from the site config appears in
//      anything the server sends back.
//
// Run from the repo root:
//   node worker/client-ops-tools/read-only-tier.smoke.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const zpool   = require('./zpool-status');
const snaps   = require('./list-snapshots');
const space   = require('./receiver-free-space');
const vm      = require('./vm-liveness');
const db      = require('./db-health-check');

// ── 1. Pure parser / sanitiser checks ────────────────────────────────────
function unitChecks() {
  // zpool_status: list parser
  const list = zpool._internals.parseList(
    'tank\tONLINE\nbackup\tDEGRADED\nweird\tBANANAS\n',
  );
  assert.deepStrictEqual(list, [
    { name: 'tank',   state: 'online'   },
    { name: 'backup', state: 'degraded' },
    { name: 'weird',  state: 'unknown'  },
  ]);

  // zpool_status: status block parser
  const blocks = zpool._internals.parseStatusBlocks(
    '  pool: tank\n state: ONLINE\n  scan: scrub in progress since now\n' +
    '  pool: backup\n state: DEGRADED\n  scan: resilver in progress since now\n',
  );
  assert.strictEqual(blocks.get('tank').scrub, true);
  assert.strictEqual(blocks.get('tank').resilver, false);
  assert.strictEqual(blocks.get('backup').resilver, true);

  // list_snapshots: sanitisation + parsing
  assert.strictEqual(snaps._internals.sanitiseDataset('pool/winvm'), 'pool/winvm');
  assert.strictEqual(snaps._internals.sanitiseDataset('foo; rm -rf /'), null);
  assert.strictEqual(snaps._internals.sanitiseLimit(undefined), 50);
  assert.strictEqual(snaps._internals.sanitiseLimit(10), 10);
  assert.strictEqual(snaps._internals.sanitiseLimit(0), null);
  assert.strictEqual(snaps._internals.sanitiseLimit(1001), null);
  assert.strictEqual(snaps._internals.sanitiseLimit('5'), null);
  const epochs = snaps._internals.parseEpochs('1700000000\n1700003600\n1700007200\n');
  assert.deepStrictEqual(epochs, [1700000000, 1700003600, 1700007200]);
  assert.deepStrictEqual(snaps._internals.parseEpochs(''), []);

  // receiver_free_space: space parser
  const rows = space._internals.parseSpace(
    '1000\t250\t750\n' +
    '2000\t500\t1500\n' +
    'garbage line\n',
  );
  assert.deepStrictEqual(rows, [
    { size: 1000, alloc: 250,  free: 750  },
    { size: 2000, alloc: 500,  free: 1500 },
  ]);

  // vm_liveness: state normalisation
  assert.strictEqual(vm._internals.normaliseState('running\n'), 'running');
  assert.strictEqual(vm._internals.normaliseState('  shut off  '), 'shut off');
  assert.strictEqual(vm._internals.normaliseState('UNKNOWN-STATE'), 'unknown');

  // db_health_check: header parser
  const fb = db._internals.parseHeader([
    'Database header page information:',
    '    Flags                   0',
    '    Page size               8192',
    '    ODS version             12.0',
    '    Oldest active           4711',
    '    Next transaction        4719',
  ].join('\n') + '\n');
  assert.strictEqual(fb.page_size, 8192);
  assert.strictEqual(fb.ods_version, '12.0');
  assert.strictEqual(fb.oldest_active, 4711);
  assert.strictEqual(fb.next_transaction, 4719);
  assert.strictEqual(fb.tx_lag, 8);
  // A non-Firebird-looking blob → no fields found.
  const empty = db._internals.parseHeader('hello world\nno header here\n');
  assert.strictEqual(empty.page_size, undefined);
  assert.strictEqual(empty.ods_version, undefined);

  console.log('OK  unit: parsers + sanitisation for all 5 new tools');
}

// ── 2. End-to-end MCP smoke against a stubbed ssh ────────────────────────
async function mcpSmoke() {
  // Secrets that must NEVER appear in any tool result the server returns.
  const SECRETS = {
    HOST: 'SECRET-HOST-203-0-113-77',
    USER: 'SECRET-USER-zoperator',
    KEY:  '/home/waz/SECRET-KEY-PATH/id_rsa',
    VM:   'SECRET-VM-clinical-winvm',
    DB:   '/srv/SECRET-DB/clinical.fdb',
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-ro-smoke-'));
  const cfgPath = path.join(tmpDir, 'client-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: {
        host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY,
        vm_name: SECRETS.VM,
        service_port: 3050,
        service_host: '127.0.0.1',
        db_path: SECRETS.DB,
      },
      // A second site to confirm tools that require optional config error
      // cleanly when those fields are absent.
      BARE: {
        host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY,
      },
    },
  }));

  // Stub ssh on PATH. We branch on the *full* remote command string so we
  // can hit each tool's distinct invocation pattern.
  const stubDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(stubDir);
  const fakeNow = Math.floor(Date.now() / 1000);
  const sshStub = `#!/usr/bin/env node
const remote = process.argv[process.argv.length - 1] || '';
function emit(s) { process.stdout.write(s); }
// zpool list -H -o name,health  (zpool_status)
if (remote === 'zpool list -H -o name,health') {
  emit('tank\\tONLINE\\nbackup\\tDEGRADED\\n');
  process.exit(0);
}
// zpool status  (zpool_status flags)
if (remote === 'zpool status') {
  emit('  pool: tank\\n state: ONLINE\\n  scan: scrub in progress since now\\n');
  emit('  pool: backup\\n state: DEGRADED\\n  scan: resilver in progress since now\\n');
  process.exit(0);
}
// zpool list -Hp -o size,alloc,free  (receiver_free_space)
if (remote === 'zpool list -Hp -o size,alloc,free') {
  emit('1000\\t250\\t750\\n2000\\t500\\t1500\\n');
  process.exit(0);
}
// zfs list -p -H -o creation -t snapshot ...  (list_snapshots)
if (remote.startsWith('zfs list -p -H -o creation -t snapshot')) {
  emit('${fakeNow - 7200}\\n${fakeNow - 3600}\\n${fakeNow}\\n');
  process.exit(0);
}
// virsh domstate ...  (vm_liveness)
if (remote.startsWith('virsh domstate')) {
  emit('running\\n');
  process.exit(0);
}
// timeout 5 bash -c '< /dev/tcp/...'  (vm_liveness probe) → succeed
if (remote.startsWith('timeout 5 bash -c')) {
  process.exit(0);
}
// gstat -h ...  (db_health_check)
if (remote.indexOf('gstat') === 0 || remote.startsWith("'gstat'")) {
  emit('Database header page information:\\n');
  emit('    Flags                   0\\n');
  emit('    Page size               8192\\n');
  emit('    ODS version             12.0\\n');
  emit('    Oldest active           4711\\n');
  emit('    Next transaction        4719\\n');
  process.exit(0);
}
process.stderr.write('fake-ssh: unknown remote cmd: ' + remote + '\\n');
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

  // Collected texts from every tool result, asserted secret-free at the end.
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

    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name).sort();
    assert.deepStrictEqual(names, [
      // create_snapshot (mcp-task 05) and kick_replication + kill_stuck_send
      // (mcp-task 06) are the mutating-tier tools; their own behaviour is
      // covered in mutating-tier.smoke.js. They show up here only because
      // tools/list returns the full registry.
      'create_snapshot',
      'db_health_check',
      'kick_replication',
      'kill_stuck_send',
      'list_snapshots',
      'receiver_free_space',
      'vm_liveness',
      'zfs_replication_status',
      'zpool_status',
    ]);
    // Every input schema must enumerate sites exactly — that's the boundary.
    for (const t of list.result.tools) {
      assert.deepStrictEqual(t.inputSchema.properties.site.enum.sort(), ['A', 'BARE']);
    }

    // zpool_status — two pools, mixed health, scrub + resilver flags.
    const zp = await callTool('zpool_status', { site: 'A' });
    assert.deepStrictEqual(zp, {
      pools: [
        { state: 'online',   scrub_in_progress: true,  resilver_in_progress: false },
        { state: 'degraded', scrub_in_progress: false, resilver_in_progress: true  },
      ],
    });

    // list_snapshots — three epochs, newest-first, names stripped, limit 2.
    const ls = await callTool('list_snapshots', { site: 'A', dataset: 'pool0/winvm', limit: 2 });
    assert.strictEqual(ls.count, 3);
    assert.strictEqual(ls.snapshots.length, 2);
    assert.ok(/T.*Z$/.test(ls.snapshots[0].created));
    // Newest first: snapshots[0] must be more recent than snapshots[1].
    assert.ok(new Date(ls.snapshots[0].created) > new Date(ls.snapshots[1].created));

    // list_snapshots — bad dataset rejected without an ssh round-trip.
    const lsBad = await callTool('list_snapshots', { site: 'A', dataset: 'foo; echo OWNED' });
    assert.strictEqual(lsBad.error, 'invalid_dataset');

    // receiver_free_space — aggregate of two pools.
    const rfs = await callTool('receiver_free_space', { site: 'A' });
    assert.strictEqual(rfs.pools, 2);
    assert.strictEqual(rfs.total_bytes, 3000);
    assert.strictEqual(rfs.allocated_bytes, 750);
    assert.strictEqual(rfs.free_bytes, 2250);
    assert.strictEqual(rfs.used_percent, 25);

    // vm_liveness — running, port open.
    const vmRes = await callTool('vm_liveness', { site: 'A' });
    assert.deepStrictEqual(vmRes, { vm_state: 'running', service_port_open: true });

    // vm_liveness on BARE site → config-error, no ssh call attempted.
    const vmBare = await callTool('vm_liveness', { site: 'BARE' });
    assert.strictEqual(vmBare.error, 'site_not_configured_for_vm_liveness');

    // db_health_check — parses out the four canonical fields.
    const dbRes = await callTool('db_health_check', { site: 'A' });
    assert.strictEqual(dbRes.ok, true);
    assert.strictEqual(dbRes.page_size, 8192);
    assert.strictEqual(dbRes.ods_version, '12.0');
    assert.strictEqual(dbRes.oldest_active, 4711);
    assert.strictEqual(dbRes.next_transaction, 4719);
    assert.strictEqual(dbRes.tx_lag, 8);

    // db_health_check on BARE site → config-error.
    const dbBare = await callTool('db_health_check', { site: 'BARE' });
    assert.strictEqual(dbBare.error, 'site_not_configured_for_db_health');

    // Cardinal property: no secret value from the config appears in any
    // serialised tool result the model would see.
    const blob = allResultTexts.join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!blob.includes(v), `result text leaked SECRETS.${k} ("${v}")`);
    }
    // And no pool/dataset/snapshot prose leaked through either.
    for (const leak of ['tank', 'backup', 'pool0', 'winvm', '@snap']) {
      assert.ok(!blob.includes(leak), `result text leaked stub token "${leak}"`);
    }

    console.log('OK  e2e: read-only tier MCP responses, zero secret leakage');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server stderr]\n${stderrBuf}\n`);
}

(async () => {
  unitChecks();
  await mcpSmoke();
  console.log('all read-only tier smoke checks passed');
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
