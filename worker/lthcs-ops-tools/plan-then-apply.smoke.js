'use strict';

// Smoke for the plan-then-apply tier (CLIENT_OPS_MCP_DESIGN.md §5):
//   *_plan tools (5):    create_snapshot_plan, kick_replication_plan,
//                        kill_stuck_send_plan, restart_service_plan,
//                        raw_ssh_exec_plan.
//   apply_plan:          the single mutating execution path.
//
// Three layers, mirroring the other tiers' smokes:
//   1. Pure unit checks on the plan store + sanitisers, no network.
//   2. End-to-end MCP server subprocess driven over stdio. A fake worker
//      HTTP listener captures /plans/register POSTs so we can assert that
//      the plan body the worker would surface on the approval card is the
//      one the model saw — the headline guarantee of the spec.
//   3. PATH is shadowed with a Node stub that pretends to be ssh, records
//      the remote command, and either succeeds or fails on demand. The
//      cardinal invariant is checked at the end: NO secret config value
//      appears in any tool result the server sent back to the model.
//
// Run from the repo root:
//   node worker/lthcs-ops-tools/plan-then-apply.smoke.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const plansLib   = require('./_plans');
const apply      = require('./apply-plan');
const csPlan     = require('./create-snapshot-plan');
const ksPlan     = require('./kill-stuck-send-plan');
const krPlan     = require('./kick-replication-plan');
const rsPlan     = require('./restart-service-plan');
const rawPlan    = require('./raw-ssh-exec-plan');

// ── 1. Pure unit checks ──────────────────────────────────────────────────
function unitChecks() {
  // Plan ID shape: prefixed hex, hard to guess.
  const id1 = plansLib._internals.mintPlanId();
  const id2 = plansLib._internals.mintPlanId();
  assert.ok(/^plan_[0-9a-f]{32}$/.test(id1), `plan_id malformed: ${id1}`);
  assert.notStrictEqual(id1, id2, 'plan ids must not collide');

  // Envelope/round-trip: store, look up, model view drops private state.
  const env = plansLib.makeEnvelope({
    tool: 'create_snapshot',
    site_label: 'A',
    reason: 'test',
    affects: ['dataset:p/w'],
    steps_model_view: [{ kind: 'ssh_exec', site_label: 'A', remote_command: 'zfs snapshot p/w@runn-pre-mutate-1700000000', timeout_ms: 30000, label: 'snap' }],
    executor_state: { kind: 'create_snapshot', dataset: 'p/w', tag: 'runn-pre-mutate-1700000000' },
  });
  assert.ok(env.plan_id.startsWith('plan_'));
  const stored = plansLib.getPlan(env.plan_id);
  assert.ok(stored, 'plan must be retrievable after make');
  assert.strictEqual(stored._executor_state.tag, 'runn-pre-mutate-1700000000');

  const view = plansLib.toModelView(env);
  assert.strictEqual(view.plan_id, env.plan_id);
  assert.strictEqual(view.tool, 'create_snapshot');
  assert.deepStrictEqual(view.affects, ['dataset:p/w']);
  assert.strictEqual('_executor_state' in view, false,
    'model view must NOT carry private _executor_state — that would leak the raw site lookup hints');
  assert.strictEqual(view.steps[0].remote_command, 'zfs snapshot p/w@runn-pre-mutate-1700000000');

  // deletePlan removes from store; subsequent lookup returns null.
  plansLib.deletePlan(env.plan_id);
  assert.strictEqual(plansLib.getPlan(env.plan_id), null);

  // apply-plan handler sanitisers — empty/long reason rejected.
  assert.strictEqual(apply._internals.sanitiseReason(''), null);
  assert.strictEqual(apply._internals.sanitiseReason('   '), null);
  assert.strictEqual(apply._internals.sanitiseReason('x'.repeat(501)), null);
  assert.strictEqual(apply._internals.sanitiseReason('  go  '), 'go');

  // EXECUTORS is the dispatch table — extending tools means adding here.
  assert.deepStrictEqual(
    Object.keys(apply._internals.EXECUTORS).slice().sort(),
    ['create_snapshot', 'kick_replication', 'kill_stuck_send', 'raw_ssh_exec', 'restart_service'],
    'apply_plan dispatch table drifted — every mutating tool needs an executor',
  );

  // normaliseServiceState parity with restart_service.
  assert.strictEqual(apply._internals.normaliseServiceState(true, 'active\n'), 'running');
  assert.strictEqual(apply._internals.normaliseServiceState(true, 'failed'),   'stopped');
  assert.strictEqual(apply._internals.normaliseServiceState(false, 'active'),  'unknown');
  assert.strictEqual(apply._internals.normaliseServiceState(true, 'unknown'),  'unknown');

  console.log('OK  unit: plan store + envelope shape + sanitisers + executor table');
}

// ── 2. + 3. End-to-end via MCP stdio + fake worker + stubbed ssh ──────────
async function endToEnd() {
  const SECRETS = {
    HOST: 'SECRET-HOST-198-51-100-22',
    USER: 'SECRET-USER-ops',
    KEY:  '/home/waz/SECRET-KEY-PATH/id_rsa_plans',
    KICK: '/secret/path/SECRET-KICK-CMD',
    KILL: '/secret/path/SECRET-KILL-CMD',
    STATUS_FB:   'SECRET-STATUS-FIREBIRD-CMD',
    RESTART_FB:  'SECRET-RESTART-FIREBIRD-CMD',
    STATUS_NRX:  'SECRET-STATUS-NODERED-CMD',
    RESTART_NRX: 'SECRET-RESTART-NODERED-CMD',
  };
  const TOKEN = 'fake-perm-token-for-plan-smoke';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-plan-smoke-'));
  const cfgPath = path.join(tmpDir, 'lthcs-ops.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    sites: {
      A: {
        host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY,
        replication_kick_cmd: SECRETS.KICK + ' {dataset}',
        replication_kill_cmd: SECRETS.KILL + ' {dataset}',
        services: {
          firebird: {
            status_cmd: SECRETS.STATUS_FB,
            restart_cmd: SECRETS.RESTART_FB,
            stateful_dataset: 'pool0/winvm',
          },
          node_red_executor: {
            status_cmd: SECRETS.STATUS_NRX,
            restart_cmd: SECRETS.RESTART_NRX,
          },
        },
      },
      BARE: { host: SECRETS.HOST, user: SECRETS.USER, ssh_key_path: SECRETS.KEY },
    },
  }));

  // Stub ssh — same shape as the mutating tier smoke. Records to a sentinel
  // file; recognises zfs snapshot / kick / kill / status / restart prefixes.
  const stubDir = path.join(tmpDir, 'bin');
  const sentinelPath = path.join(tmpDir, 'ssh-calls.log');
  fs.mkdirSync(stubDir);
  const sshStub = `#!/usr/bin/env node
const fs = require('fs');
const remote = process.argv[process.argv.length - 1] || '';
fs.appendFileSync(${JSON.stringify(sentinelPath)}, remote + '\\n');
if (remote.startsWith('zfs snapshot ')) process.exit(0);
if (remote.startsWith(${JSON.stringify(SECRETS.KICK + ' ')})) process.exit(0);
if (remote.startsWith(${JSON.stringify(SECRETS.KILL + ' ')})) {
  process.stdout.write('3\\n'); process.exit(0);
}
if (remote === ${JSON.stringify(SECRETS.STATUS_FB)}) { process.stdout.write('active\\n'); process.exit(0); }
if (remote === ${JSON.stringify(SECRETS.STATUS_NRX)}) { process.stdout.write('inactive\\n'); process.exit(0); }
if (remote === ${JSON.stringify(SECRETS.RESTART_FB)} || remote === ${JSON.stringify(SECRETS.RESTART_NRX)}) process.exit(0);
if (remote.startsWith('RAW-OK-SENTINEL')) { process.stdout.write('STDOUT-OK\\n'); process.exit(0); }
process.stderr.write('fake-ssh: unexpected remote cmd: ' + remote + '\\n');
process.exit(2);
`;
  fs.writeFileSync(path.join(stubDir, 'ssh'), sshStub, { mode: 0o755 });

  // ── Fake worker: capture /plans/register and /permissions/request bodies.
  // We don't need to drive real approvals here (the CLI gate doesn't fire in
  // a direct stdio smoke); we just need to verify that the plan body the
  // worker WOULD surface is what we expect. The MCP server fires-and-forgets
  // to /plans/register, so we collect those posts and inspect them after.
  const planPosts = [];
  const fakeWorker = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/plans/register') {
        try { planPosts.push(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(resolve => fakeWorker.listen(0, '127.0.0.1', resolve));
  const fakeWorkerPort = fakeWorker.address().port;

  const serverPath = path.join(__dirname, '..', 'lthcs-ops.js');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PATH: stubDir + path.delimiter + process.env.PATH,
      LTHCS_OPS_CONFIG: cfgPath,
      LTHCS_OPS_ALLOW_RAW_SSH: '1',          // exercises raw_ssh_exec_plan
      RUNN_PORT: String(fakeWorkerPort),
      RUNN_HOST: '127.0.0.1',
      RUNN_PERMISSION_TOKEN: TOKEN,
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
  async function callTool(name, args) {
    const resp = await rpc('tools/call', { name, arguments: args });
    assert.ok(resp.result && resp.result.content && resp.result.content[0],
      `${name}: missing content (resp=${JSON.stringify(resp)})`);
    const text = resp.result.content[0].text;
    allResultTexts.push(text);
    return JSON.parse(text);
  }
  // Small helper to give the fire-and-forget /plans/register POST time to land
  // on the fake worker before we inspect planPosts. The MCP server's handler
  // awaits the request, but the worker isn't on our event loop directly.
  const tickIO = () => new Promise(r => setImmediate(r));

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plan-smoke', version: '0' } });

    // ── tools/list shape ────────────────────────────────────────────────
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map(t => t.name);
    for (const expected of [
      'create_snapshot_plan', 'kick_replication_plan', 'kill_stuck_send_plan',
      'restart_service_plan', 'raw_ssh_exec_plan', 'apply_plan',
    ]) {
      assert.ok(names.includes(expected), `tools/list missing ${expected}`);
    }
    const applyEntry = list.result.tools.find(t => t.name === 'apply_plan');
    assert.deepStrictEqual(applyEntry.inputSchema.required.slice().sort(), ['plan_id', 'reason'],
      'apply_plan must require exactly {plan_id, reason}');
    assert.strictEqual(applyEntry.inputSchema.additionalProperties, false);

    // ── create_snapshot_plan + apply_plan happy path ────────────────────
    const csCallsBefore = sshCallCount(sentinelPath);
    const planRes = await callTool('create_snapshot_plan', {
      site: 'A', dataset: 'pool0/winvm',
      reason: 'pre-migration insurance',
    });
    assert.strictEqual(planRes.ok, true);
    assert.ok(planRes.plan && planRes.plan.plan_id, 'create_snapshot_plan must return plan.plan_id');
    assert.strictEqual(planRes.plan.tool, 'create_snapshot');
    assert.deepStrictEqual(planRes.plan.affects, ['dataset:pool0/winvm']);
    assert.strictEqual(planRes.plan.steps.length, 1);
    assert.ok(/^zfs snapshot pool0\/winvm@runn-pre-mutate-\d+$/.test(planRes.plan.steps[0].remote_command),
      `step remote_command malformed: ${planRes.plan.steps[0].remote_command}`);
    // Acceptance criterion: planning does NOT execute. No ssh call yet.
    assert.strictEqual(sshCallCount(sentinelPath), csCallsBefore,
      'create_snapshot_plan must NOT fire an ssh call');

    // The plan body POSTed to the worker matches what the model saw — that's
    // the "approval shows the plan body" invariant.
    await tickIO();
    const post = planPosts.find(p => p.plan_id === planRes.plan.plan_id);
    assert.ok(post, '*_plan tool must register the plan with the worker');
    assert.strictEqual(post.token, TOKEN, 'plan must be registered under the session token');
    assert.deepStrictEqual(post.plan, planRes.plan,
      'worker-registered plan must equal the body the model saw');

    // apply_plan executes; result wraps the per-tool create_snapshot result.
    const applied = await callTool('apply_plan', {
      plan_id: planRes.plan.plan_id, reason: 'go',
    });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.tool, 'create_snapshot');
    assert.strictEqual(applied.plan_id, planRes.plan.plan_id);
    assert.strictEqual(applied.result.ok, true);
    // The frozen tag from plan time IS the tag the apply actually ran.
    const plannedTag = planRes.plan.steps[0].remote_command.split('@')[1];
    assert.strictEqual(applied.result.tag, plannedTag,
      'apply_plan must replay the FROZEN tag from plan time, not a fresh one');
    // ssh stub recorded exactly one call: the snapshot with the frozen tag.
    const csCallsAfter = sshCallCount(sentinelPath);
    assert.strictEqual(csCallsAfter, csCallsBefore + 1, 'apply_plan should fire exactly one ssh call');
    const lastCmd = lastSshCall(sentinelPath);
    assert.strictEqual(lastCmd, `zfs snapshot pool0/winvm@${plannedTag}`,
      'apply_plan ran a different command than the plan locked in');

    // Single-use: applying the SAME plan_id again must fail (envelope deleted).
    const reapply = await callTool('apply_plan', { plan_id: planRes.plan.plan_id, reason: 'try again' });
    assert.deepStrictEqual(reapply, { error: 'unknown_plan' },
      'plans must be single-use; second apply_plan with the same id must error');

    console.log('OK  e2e: create_snapshot_plan returns body + freezes tag; apply_plan executes that exact plan; single-use enforced');

    // ── unknown_plan + invalid_reason on apply_plan ─────────────────────
    const unknown = await callTool('apply_plan', { plan_id: 'plan_deadbeef', reason: 'x' });
    assert.deepStrictEqual(unknown, { error: 'unknown_plan' });
    const badReason = await callTool('apply_plan', { plan_id: 'plan_deadbeef', reason: '   ' });
    assert.deepStrictEqual(badReason, { error: 'invalid_reason' });

    // ── kick_replication_plan + apply_plan ──────────────────────────────
    const krCallsBefore = sshCallCount(sentinelPath);
    const krPlanRes = await callTool('kick_replication_plan', {
      site: 'A', dataset: 'pool0/winvm', reason: 'manual re-fire after WG flap',
    });
    assert.strictEqual(krPlanRes.ok, true);
    assert.strictEqual(krPlanRes.plan.tool, 'kick_replication');
    assert.strictEqual(krPlanRes.plan.steps.length, 2);
    assert.strictEqual(krPlanRes.plan.steps[1].kind, 'ssh_exec_configured',
      'kick step 2 must be the abstract "ssh_exec_configured" — raw kick cmd is a config secret');
    assert.ok(!('remote_command' in krPlanRes.plan.steps[1]),
      'configured-cmd steps must NOT carry remote_command (the raw text is a secret)');
    assert.ok(krPlanRes.plan.steps[1].remote_command_abstract.includes('pool0/winvm'),
      'configured-cmd abstract should still show the model-supplied dataset');
    // No ssh yet.
    assert.strictEqual(sshCallCount(sentinelPath), krCallsBefore);

    const krApplied = await callTool('apply_plan', {
      plan_id: krPlanRes.plan.plan_id, reason: 'go for kick',
    });
    assert.strictEqual(krApplied.ok, true);
    assert.strictEqual(krApplied.result.ok, true);
    assert.strictEqual(krApplied.result.fired, true);
    const krFrozenTag = krPlanRes.plan.steps[0].remote_command.split('@')[1];
    assert.strictEqual(krApplied.result.snapshot_tag, krFrozenTag,
      'kick_replication apply must use the FROZEN snapshot tag');
    const krCalls = readSshCalls(sentinelPath);
    assert.strictEqual(krCalls[krCallsBefore + 0], `zfs snapshot pool0/winvm@${krFrozenTag}`);
    assert.strictEqual(krCalls[krCallsBefore + 1], `${SECRETS.KICK} pool0/winvm`,
      'kick apply must run the ACTUAL configured kick command — the raw text was only in live config, not the envelope');

    console.log('OK  e2e: kick_replication_plan freezes snapshot tag; apply runs snapshot + configured kick');

    // ── kill_stuck_send_plan + apply_plan ───────────────────────────────
    const ksCallsBefore = sshCallCount(sentinelPath);
    const ksPlanRes = await callTool('kill_stuck_send_plan', {
      site: 'A', dataset: 'pool0/winvm', reason: 'stuck send remediation',
    });
    assert.strictEqual(ksPlanRes.ok, true);
    assert.strictEqual(ksPlanRes.plan.steps.length, 1,
      'kill_stuck_send takes NO pre-mutate snapshot — plan must reflect that');
    assert.strictEqual(ksPlanRes.plan.steps[0].kind, 'ssh_exec_configured',
      'site A has replication_kill_cmd configured → step must be abstract, not raw');
    assert.strictEqual(sshCallCount(sentinelPath), ksCallsBefore);

    const ksApplied = await callTool('apply_plan', {
      plan_id: ksPlanRes.plan.plan_id, reason: 'execute kill',
    });
    assert.deepStrictEqual(ksApplied.result, { ok: true, killed: 3 });
    const ksCalls = readSshCalls(sentinelPath);
    assert.strictEqual(ksCalls[ksCallsBefore + 0], `${SECRETS.KILL} pool0/winvm`,
      'kill apply must run the configured kill command');

    // BARE site has no configured kill → plan shows the fallback recipe literally.
    const ksBarePlan = await callTool('kill_stuck_send_plan', {
      site: 'BARE', dataset: 'pool0/winvm', reason: 'fallback recipe path',
    });
    assert.strictEqual(ksBarePlan.ok, true);
    assert.strictEqual(ksBarePlan.plan.steps[0].kind, 'ssh_exec',
      'BARE site has no configured kill → fallback recipe is shown literally, NOT abstracted');
    assert.ok(ksBarePlan.plan.steps[0].remote_command.startsWith("pids=$(pgrep -af 'zfs send'"),
      `BARE fallback plan should show the pgrep recipe verbatim: ${ksBarePlan.plan.steps[0].remote_command}`);

    console.log('OK  e2e: kill_stuck_send_plan has no pre-mutate snapshot; configured vs fallback recipe handled');

    // ── restart_service_plan + apply_plan ───────────────────────────────
    const rsCallsBefore = sshCallCount(sentinelPath);
    const rsPlanRes = await callTool('restart_service_plan', {
      site: 'A', service: 'firebird', reason: 'apply pending hotfix',
    });
    assert.strictEqual(rsPlanRes.ok, true);
    // Stateful service → 4 steps: status, snapshot, restart, status.
    assert.strictEqual(rsPlanRes.plan.steps.length, 4);
    assert.strictEqual(rsPlanRes.plan.steps[1].kind, 'ssh_exec',
      'restart_service plan step 2 (the snapshot) must be a literal zfs snapshot, tag frozen at plan time');
    assert.ok(/^zfs snapshot pool0\/winvm@runn-pre-mutate-\d+$/.test(rsPlanRes.plan.steps[1].remote_command));
    const rsFrozenTag = rsPlanRes.plan.steps[1].remote_command.split('@')[1];

    const rsApplied = await callTool('apply_plan', {
      plan_id: rsPlanRes.plan.plan_id, reason: 'do the restart',
    });
    assert.strictEqual(rsApplied.result.service, 'firebird');
    assert.strictEqual(rsApplied.result.snapshot_tag, rsFrozenTag,
      'restart_service apply must replay the FROZEN snapshot tag');
    const rsCalls = readSshCalls(sentinelPath);
    assert.strictEqual(rsCalls[rsCallsBefore + 0], SECRETS.STATUS_FB);
    assert.strictEqual(rsCalls[rsCallsBefore + 1], `zfs snapshot pool0/winvm@${rsFrozenTag}`);
    assert.strictEqual(rsCalls[rsCallsBefore + 2], SECRETS.RESTART_FB);
    assert.strictEqual(rsCalls[rsCallsBefore + 3], SECRETS.STATUS_FB);

    // Stateless service → 3 steps, no snapshot.
    const nrxPlanRes = await callTool('restart_service_plan', {
      site: 'A', service: 'node_red_executor', reason: 'pick up new flow',
    });
    assert.strictEqual(nrxPlanRes.plan.steps.length, 3,
      'stateless service plan must NOT include a snapshot step');
    for (const step of nrxPlanRes.plan.steps) {
      assert.notStrictEqual(step.kind, 'ssh_exec',
        'stateless service has no literal zfs snapshot; all steps should be abstract configured ones');
    }

    console.log('OK  e2e: restart_service_plan freezes snapshot for stateful only; apply replays plan');

    // ── raw_ssh_exec_plan + apply_plan ──────────────────────────────────
    const rawCallsBefore = sshCallCount(sentinelPath);
    const rawPlanRes = await callTool('raw_ssh_exec_plan', {
      site: 'A', command: 'RAW-OK-SENTINEL diagnose stuck send',
      justification: 'investigate weird pool state — no curated tool covers this',
    });
    assert.strictEqual(rawPlanRes.ok, true);
    assert.strictEqual(rawPlanRes.plan.tool, 'raw_ssh_exec');
    assert.strictEqual(rawPlanRes.plan.steps[0].kind, 'ssh_exec',
      'raw_ssh_exec plan step IS the literal command — the operator must see it for review');
    assert.strictEqual(rawPlanRes.plan.steps[0].remote_command, 'RAW-OK-SENTINEL diagnose stuck send');
    assert.strictEqual(rawPlanRes.plan.steps[0].danger, true,
      'raw_ssh_exec plan steps must be flagged danger:true so the approval card can render in a danger palette');
    // No ssh yet.
    assert.strictEqual(sshCallCount(sentinelPath), rawCallsBefore);

    const rawApplied = await callTool('apply_plan', {
      plan_id: rawPlanRes.plan.plan_id, reason: 'authorise diagnostic command',
    });
    assert.strictEqual(rawApplied.result.ok, true);
    assert.ok(rawApplied.result.stdout.includes('STDOUT-OK'));
    const rawCalls = readSshCalls(sentinelPath);
    assert.strictEqual(rawCalls[rawCallsBefore + 0], 'RAW-OK-SENTINEL diagnose stuck send');

    console.log('OK  e2e: raw_ssh_exec_plan echoes literal command + danger flag; apply runs that exact command');

    // ── PLAN audit lines fired on stderr, MUTATING line for apply_plan ──
    for (const planTool of [
      'create_snapshot_plan', 'kick_replication_plan', 'kill_stuck_send_plan',
      'restart_service_plan', 'raw_ssh_exec_plan',
    ]) {
      assert.ok(new RegExp(`PLAN tool=${planTool}`).test(stderrBuf),
        `expected PLAN audit line for ${planTool} on stderr, got:\n${stderrBuf}`);
    }
    assert.ok(/MUTATING tool=apply_plan/.test(stderrBuf),
      `expected MUTATING audit line for apply_plan on stderr, got:\n${stderrBuf}`);
    assert.ok(/APPLY_PLAN plan_id=/.test(stderrBuf),
      'expected dedicated APPLY_PLAN audit line on stderr');

    // ── Cardinal invariant: NO secret config value in any tool result text ─
    const blob = allResultTexts.join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!blob.includes(v),
        `result text leaked SECRETS.${k} ("${v}") — plan-then-apply tier must match boundary invariant`);
    }
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!stderrBuf.includes(v),
        `stderr leaked SECRETS.${k} ("${v}") in plan-tier audit`);
    }

    // The fake worker also captured plan bodies — they too must be clean.
    const planBlob = planPosts.map(p => JSON.stringify(p.plan)).join('\n');
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!planBlob.includes(v),
        `registered plan body leaked SECRETS.${k} ("${v}") — approval card would have surfaced the secret`);
    }

    console.log('OK  e2e: PLAN + APPLY_PLAN audit lines fired; zero secret leakage on wire or in registered bodies');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    fakeWorker.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server stderr]\n${stderrBuf}\n`);
}

// Small filesystem helpers for the ssh-call ledger sentinel.
function readSshCalls(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return [];
  return raw.trim().split('\n');
}
function sshCallCount(p) { return readSshCalls(p).length; }
function lastSshCall(p) { const arr = readSshCalls(p); return arr[arr.length - 1] || null; }

(async () => {
  unitChecks();
  await endToEnd();
  console.log('all plan-then-apply smoke checks passed');
})().catch(err => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
