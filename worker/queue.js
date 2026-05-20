'use strict';

// AI-task queue: when an AI task's stated goal is met (subprocess exit 0 + optional
// acceptance check passes), mark it done and start the next AI task in sort_order
// within the same project. A human task in the queue pauses progress until the
// human marks the task done (PATCH /cards in server.js calls maybeAdvanceQueue
// to resume).

const { spawn } = require('child_process');

const ACCEPTANCE_TIMEOUT_MS = 5 * 60 * 1000;

// Run a shell command (sh -c) and resolve with { ok, output, code }.
function runShell(value, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', value], { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, output: `${out}\n${err}\n[acceptance check: timed out after ${ACCEPTANCE_TIMEOUT_MS}ms]`, code: -1 });
    }, ACCEPTANCE_TIMEOUT_MS);
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: code === 0, output: `${out}\n${err}`.trim(), code });
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: false, output: String(e.message || e), code: -1 });
    });
  });
}

// Run a "prompt" acceptance check by invoking `claude -p --print <value>` in the
// project cwd. Pass iff stdout contains a trailing PASS marker.
function runPromptCheck(value, cwd) {
  const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--print', value], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let done = false;
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, output: `${out}\n${err}\n[acceptance prompt: timed out]`, code: -1 });
    }, ACCEPTANCE_TIMEOUT_MS);
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      const trailing = (out || '').trim().split(/\s+/).slice(-3).join(' ').toUpperCase();
      const passed = code === 0 && /\bPASS\b/.test(trailing);
      resolve({ ok: passed, output: `${out}\n${err}`.trim(), code });
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: false, output: String(e.message || e), code: -1 });
    });
  });
}

async function runAcceptanceCheck(card) {
  const ac = card.acceptance_check;
  if (!ac || !ac.type || !ac.value) return { ok: true, output: '', skipped: true };
  const cwd = (card.location && card.location.cwd) || process.cwd();
  if (ac.type === 'shell') return runShell(ac.value, cwd);
  if (ac.type === 'prompt') return runPromptCheck(ac.value, cwd);
  return { ok: false, output: `unknown acceptance_check.type: ${ac.type}`, code: -1 };
}

// Called when an AI subprocess (spawned via /ai-ify) exits.
// code === 0 → maybe run acceptance check → mark done + advance, else block + halt.
async function handleAiExit(cardId, code, deps) {
  const { readJson, atomicWriteJson, cardPath, nowIso } = deps;
  let card;
  try { card = await readJson(cardPath(cardId)); }
  catch (err) { console.error(`[queue] card ${cardId} not found on exit`, err); return; }

  // Guard against double-advance: if a user already marked this done manually,
  // don't run the check or advance again from the exit callback.
  if (card.status === 'done' || card.status === 'blocked') {
    console.log(`[queue] ${cardId} already ${card.status} on exit (code=${code}); not advancing`);
    return;
  }

  if (code !== 0) {
    const next = { ...card, status: 'blocked', updated_at: nowIso() };
    await atomicWriteJson(cardPath(cardId), next);
    console.log(`[queue] ${cardId} blocked (claude exit ${code})`);
    return;
  }

  const check = await runAcceptanceCheck(card);
  if (!check.ok) {
    const next = {
      ...card,
      status: 'blocked',
      notes_md: appendCheckLog(card.notes_md, 'FAIL', check.output),
      updated_at: nowIso(),
    };
    await atomicWriteJson(cardPath(cardId), next);
    console.log(`[queue] ${cardId} blocked (acceptance check FAILED)`);
    return;
  }

  const done = {
    ...card,
    status: 'done',
    notes_md: check.skipped ? card.notes_md : appendCheckLog(card.notes_md, 'PASS', check.output),
    updated_at: nowIso(),
  };
  await atomicWriteJson(cardPath(cardId), done);
  console.log(`[queue] ${cardId} done${check.skipped ? '' : ' (acceptance check PASS)'}`);
  if (done.parent_id) await maybeAdvanceQueue(done.parent_id, deps);
}

function appendCheckLog(notes, verdict, output) {
  const stamp = new Date().toISOString();
  const tail = (output || '').slice(-800);
  const block = `\n\n---\n[${stamp}] acceptance check: ${verdict}\n${tail}\n`;
  return (notes || '') + block;
}

// Look for the next runnable sibling under `parentId` (sorted by sort_order).
// AI + status=todo → spawn it. Human + status=todo → pause. Anything else → skip.
async function maybeAdvanceQueue(parentId, deps) {
  if (!parentId) return;
  const { listCards, bridge, onAiExit, atomicWriteJson, cardPath, nowIso } = deps;
  const all = await listCards();
  const siblings = all
    .filter(c => c.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order);

  for (const sib of siblings) {
    if (sib.status === 'done') continue;
    if (sib.status === 'blocked') {
      console.log(`[queue] halting at ${sib.id} (status=blocked)`);
      return;
    }
    if (sib.status === 'doing') {
      // Something's already running — let it complete; queue will re-trigger on exit.
      return;
    }
    if (sib.status !== 'todo') continue;

    const assignee = sib.assignee || 'human';
    if (assignee === 'human') {
      console.log(`[queue] pausing at human task ${sib.id}`);
      return;
    }
    // AI todo → spawn it.
    if (sib.session_id) continue; // already had a session, skip (defensive)
    const location = sib.location || bridge.DEFAULT_LOCATION;
    try {
      const { session_id, session_path, location: resolvedLoc } = await bridge.spawnSession({
        title: sib.title,
        location,
        onExit: (code) => onAiExit(sib.id, code),
      });
      const merged = {
        ...sib,
        status: 'doing',
        assignee: 'ai',
        session_id,
        session_path,
        location: resolvedLoc,
        origin: 'runn',
        updated_at: nowIso(),
      };
      await atomicWriteJson(cardPath(sib.id), merged);
      console.log(`[queue] auto-started ${sib.id} → session ${session_id.slice(0,8)}`);
    } catch (err) {
      console.error(`[queue] failed to auto-start ${sib.id}`, err);
      await atomicWriteJson(cardPath(sib.id), { ...sib, status: 'blocked', updated_at: nowIso() });
    }
    return;
  }
}

module.exports = { handleAiExit, maybeAdvanceQueue, runAcceptanceCheck };
