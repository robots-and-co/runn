'use strict';

// Smoke for the mutating tier:
//   - create_snapshot (and the shared _snapshot.js pre-hook helper) — task 05.
//   - kick_replication, kill_stuck_send                              — task 06.
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
const kick   = require('./kick-replication');
const kill   = require('./kill-stuck-send');

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
    // kick_replication: template substitution + positional fallback.
    assert.strictEqual(
      kick._internals.buildKickCmd('kick.sh {dataset}', 'pool0/winvm'),
      'kick.sh pool0/winvm',
    );
    assert.strictEqual(
      kick._internals.buildKickCmd('kick.sh', 'pool0/winvm'),
      'kick.sh pool0/winvm',
    );
    assert.strictEqual(
      kick._internals.buildKickCmd('echo {dataset} && go {dataset}', 'a/b'),
      'echo a/b && go a/b',
    );
    // Shared sanitisers — same charset / 500-char reason as create_snapshot.
    assert.strictEqual(kick._internals.sanitiseDataset('foo; rm /'), null);
    assert.strictEqual(kick._internals.sanitiseReason('  '), null);

    // kill_stuck_send: template substitution wins when given, positional
    // fallback otherwise, AND a non-empty default pipeline when no template.
    assert.strictEqual(
      kill._internals.buildKillCmd('kill.sh {dataset}', 'pool0/winvm'),
      'kill.sh pool0/winvm',
    );
    assert.strictEqual(
      kill._internals.buildKillCmd('kill.sh', 'pool0/winvm'),
      'kill.sh pool0/winvm',
    );
    const fallback = kill._internals.buildKillCmd(undefined, 'pool0/winvm');
    assert.ok(fallback.includes("pgrep -af 'zfs send'"),
      'fallback kill cmd should pgrep zfs send');
    assert.ok(fallback.includes('kill -TERM'),
      'fallback kill cmd should SIGTERM');
    assert.ok(fallback.includes('pool0/winvm'),
      'fallback kill cmd should filter by dataset');

    // parseKilledCount: first-line integer; reject anything else.
    assert.strictEqual(kill._internals.parseKilledCount('0\n'), 0);
    assert.strictEqual(kill._internals.parseKilledCount('3\n'), 3);
    assert.strictEqual(kill._internals.parseKilledCount('3\n12345 ...\n'), 3);
    assert.strictEqual(kill._internals.parseKilledCount('not-a-number\n'), null);
    assert.strictEqual(kill._internals.parseKilledCount(''), null);
    assert.strictEqual(kill._internals.parseKilledCount('-1\n'), null);
    assert.strictEqual(kill._internals.parseKilledCount('2.5\n'), null);

    console.log('OK  unit: snapshot helper sanitisers + tag builder + reason sanitiser');
    console.log('OK  unit: kick_replication + kill_stuck_send builders / parsers');
  });
}

// ── 2. End-to-end MCP smoke against a stubbed ssh ────────────────────────
async function mcpSmoke() {
  const SECRETS = {
    HOST: 'SECRET-HOST-203-0-113-77',
    USER: 'SECRET-USER-zoperator',
    KEY:  '/home/waz/SECRET-KEY-PATH/id_rsa',
    // Site-A is configured with operator-supplied kick/kill commands; both
    // names are sentinels we'll assert show up in the ssh stub's recorded
    // remote-cmd log (because the boundary runs them) but NOT in any tool
    // result the server sends back.
    KICK: '/secret/path/SECRET-KICK-CMD',
    KILL: '/secret/path/SECRET-KILL-CMD',
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-mut-smoke-'));
  const cfgPath = path.join(tmpDir, 'client-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: {
        host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY,
        replication_kick_cmd: SECRETS.KICK + ' {dataset}',
        replication_kill_cmd: SECRETS.KILL + ' {dataset}',
      },
      // BARE has none of the kick/kill config — the tools must error cleanly
      // (or, for kill, fall back to the safe default pipeline).
      BARE: { host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY },
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
// kick_replication: succeed on the configured KICK template; fail when the
// dataset is the "BADKICK" sentinel so we exercise the kick_failed path.
if (remote.startsWith(${JSON.stringify(SECRETS.KICK + ' ')})) {
  if (remote.indexOf('BADKICK') >= 0) { process.exit(1); }
  process.exit(0);
}
// kill_stuck_send: configured KILL template — emit a deterministic count.
if (remote.startsWith(${JSON.stringify(SECRETS.KILL + ' ')})) {
  process.stdout.write('2\\n');
  process.exit(0);
}
// kill_stuck_send: default fallback pipeline starts with the pgrep recipe.
// Match by the literal prefix the tool emits when no template is set.
if (remote.startsWith("pids=$(pgrep -af 'zfs send'")) {
  process.stdout.write('1\\n');
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

    // tools/list must include the mutating-tier tools, but their CATEGORY
    // metadata must NOT leak onto the wire — it's a server-internal label.
    const list = await rpc('tools/list', {});
    for (const tn of ['create_snapshot', 'kick_replication', 'kill_stuck_send']) {
      const t = list.result.tools.find(x => x.name === tn);
      assert.ok(t, `${tn} missing from tools/list`);
      assert.strictEqual(t.inputSchema.required.sort().join(','), 'dataset,reason,site',
        `${tn}: required fields drifted`);
      assert.strictEqual(t.inputSchema.additionalProperties, false,
        `${tn}: additionalProperties should be false`);
      assert.ok(!('CATEGORY' in t), `CATEGORY leaked into tools/list entry for ${tn}`);
      assert.ok(!('category' in t), `category leaked into tools/list entry for ${tn}`);
      // The model-visible description must spell out the kill-stuck-send remedy
      // (so future operators reading tools/list — i.e. the model — see *why*
      // killing the partial is the right move, per the spec). Cover this on
      // the kill tool specifically.
      if (tn === 'kill_stuck_send') {
        assert.ok(/resume token/i.test(t.description),
          'kill_stuck_send description must mention "no resume token" — the reason the remedy is safe');
        assert.ok(/correct.*base/i.test(t.description),
          'kill_stuck_send description must mention recomputing a correct base on next fire');
      }
    }

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
      `expected 2 ssh calls after create_snapshot happy + BADDS failure, got ${callsAfter.length}`);

    console.log('OK  e2e: create_snapshot end-to-end');

    // ── kick_replication ───────────────────────────────────────────────────
    // Happy path: site A has the operator-supplied KICK template. The tool
    // takes a pre-mutate snapshot first, then runs the kick — so we expect
    // TWO new ssh calls in order: `zfs snapshot …@<tag>` then the kick cmd
    // with the dataset substituted in.
    const kickOk = await callTool('kick_replication', {
      site: 'A', dataset: 'pool0/winvm',
      reason: 'manual re-fire after WG flap',
    });
    assert.strictEqual(kickOk.ok, true);
    assert.strictEqual(kickOk.fired, true);
    assert.ok(/^runn-pre-mutate-\d{9,}$/.test(kickOk.snapshot_tag),
      `kick snapshot_tag malformed: ${kickOk.snapshot_tag}`);

    let kickCalls = fs.readFileSync(sentinelPath, 'utf8').trim().split('\n');
    assert.strictEqual(kickCalls.length, 4,
      `expected 4 ssh calls after kick happy path, got ${kickCalls.length}`);
    assert.strictEqual(kickCalls[2], `zfs snapshot pool0/winvm@${kickOk.snapshot_tag}`,
      'kick pre-mutate snapshot did not match expected remote cmd');
    assert.strictEqual(kickCalls[3], `${SECRETS.KICK} pool0/winvm`,
      'kick remote cmd did not interpolate {dataset} into the configured template');

    // Site without a kick command → config-error, no ssh call.
    const kickBare = await callTool('kick_replication', {
      site: 'BARE', dataset: 'pool0/winvm', reason: 'should refuse',
    });
    assert.deepStrictEqual(kickBare, { error: 'site_not_configured_for_kick' });

    // Invalid reason / dataset rejected before any ssh.
    const kickBadDs = await callTool('kick_replication', {
      site: 'A', dataset: 'foo; rm /', reason: 'ok',
    });
    assert.deepStrictEqual(kickBadDs, { error: 'invalid_dataset' });
    const kickBadReason = await callTool('kick_replication', {
      site: 'A', dataset: 'pool0/winvm', reason: '   ',
    });
    assert.deepStrictEqual(kickBadReason, { error: 'invalid_reason' });

    // Failure path: dataset includes BADKICK → kick exits 1 in the stub.
    // The pre-mutate snapshot still succeeds; the response should report
    // kick_failed and carry the snapshot_tag so the operator can roll back.
    const kickFail = await callTool('kick_replication', {
      site: 'A', dataset: 'pool0/BADKICK', reason: 'expected failure',
    });
    assert.strictEqual(kickFail.error, 'kick_failed');
    assert.ok(/^runn-pre-mutate-\d{9,}$/.test(kickFail.snapshot_tag),
      'kick_failed result must include the pre-mutate snapshot_tag for rollback');

    console.log('OK  e2e: kick_replication happy + config-missing + bad-args + kick_failed');

    // ── kill_stuck_send ────────────────────────────────────────────────────
    // Happy path on A: operator KILL template → stub emits "2\n" → killed=2.
    const killOk = await callTool('kill_stuck_send', {
      site: 'A', dataset: 'pool0/winvm', reason: 'stuck send remediation',
    });
    assert.deepStrictEqual(killOk, { ok: true, killed: 2 });

    // Default fallback on BARE: no template → tool builds the pgrep recipe
    // → stub matches by literal prefix and emits "1\n".
    const killBare = await callTool('kill_stuck_send', {
      site: 'BARE', dataset: 'pool0/winvm', reason: 'fallback recipe',
    });
    assert.deepStrictEqual(killBare, { ok: true, killed: 1 });

    // Important property of kill_stuck_send: it does NOT take a pre-mutate
    // snapshot. The two kill calls above must therefore have added exactly
    // two new ssh invocations (the kill cmd itself), NOT four.
    const killCalls = fs.readFileSync(sentinelPath, 'utf8').trim().split('\n');
    // Expected ssh-call ledger so far:
    //   1-2: create_snapshot happy + BADDS failure                       (=2)
    //   3-4: kick_replication happy: snapshot + kick                     (=4)
    //   5-6: kick_replication BADKICK: snapshot + kick (kick exits 1)    (=6)
    //        (bad-args & site_not_configured paths fire no ssh)
    //   7  : kill_stuck_send happy on A (KILL template, no snapshot)     (=7)
    //   8  : kill_stuck_send fallback on BARE (default recipe, no snap)  (=8)
    assert.strictEqual(killCalls.length, 8,
      `expected 8 ssh calls total, got ${killCalls.length}\n${killCalls.join('\n')}`);
    assert.strictEqual(killCalls[6], `${SECRETS.KILL} pool0/winvm`,
      'kill template remote cmd did not interpolate {dataset}');
    assert.ok(killCalls[7].startsWith("pids=$(pgrep -af 'zfs send'"),
      `fallback kill remote cmd did not match default recipe: ${killCalls[7]}`);
    assert.ok(killCalls[7].includes('pool0/winvm'),
      'fallback kill remote cmd must filter by the dataset');

    // Bad args.
    const killBadDs = await callTool('kill_stuck_send', {
      site: 'A', dataset: 'foo; rm /', reason: 'ok',
    });
    assert.deepStrictEqual(killBadDs, { error: 'invalid_dataset' });
    const killBadReason = await callTool('kill_stuck_send', {
      site: 'A', dataset: 'pool0/winvm', reason: '',
    });
    assert.deepStrictEqual(killBadReason, { error: 'invalid_reason' });

    console.log('OK  e2e: kill_stuck_send template + fallback + no-snapshot invariant');

    // ── Cardinal invariants for the whole mutating tier ────────────────────
    // No real config secret appears in any tool result the model would see.
    const blob = allResultTexts.join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!blob.includes(v), `result text leaked SECRETS.${k} ("${v}")`);
    }

    // The MUTATING audit line must have fired on stderr for each tool.
    for (const tn of ['create_snapshot', 'kick_replication', 'kill_stuck_send']) {
      assert.ok(new RegExp(`MUTATING tool=${tn}`).test(stderrBuf),
        `expected MUTATING audit line for ${tn} on stderr, got:\n${stderrBuf}`);
    }
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!stderrBuf.includes(v), `stderr audit leaked SECRETS.${k} ("${v}")`);
    }

    console.log('OK  e2e: audit lines fired for all 3 mutating tools, zero secret leakage');
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
