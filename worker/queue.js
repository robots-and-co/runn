'use strict';

// AI-task queue. Execution is SEQUENTIAL: at most one AI subprocess running at
// a time, since all tasks share the same working tree and parallel claude
// processes would clobber each other's edits. (Parallel runs are deferred
// until per-task branching exists.)
//
// Tasks are independent by default — once an independent task is no longer
// `doing` (review/todo human/done), the queue keeps walking. A task marked
// `blocking: true` is a barrier: the queue halts at it (in any non-done state)
// until a human marks it `done`.
//
// AI never marks `done` itself. On clean exit it lands in `review` (awaiting
// human assessment); on failure, `blocked`. The human's done-click is what
// releases tasks downstream of a cleared blocker.

const { spawn } = require('child_process');
const { applyTimerTransition } = require('./timer');

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

// Called when an AI subprocess exits (initial spawn from /ai-ify or auto-queue
// spawn, and follow-up turns via /cards/:id/message).
//
// AI never marks a card `done` — that's a human-only transition. On clean exit
// the card lands in `review` (awaiting human assessment); on non-zero exit or
// failed acceptance check, in `blocked`. After settling the card, we tick the
// parent's queue so any later non-blocking siblings can advance.
async function handleAiExit(cardId, code, deps) {
  const { readJson, atomicWriteJson, cardPath, nowIso } = deps;
  let card;
  try { card = await readJson(cardPath(cardId)); }
  catch (err) { console.error(`[queue] card ${cardId} not found on exit`, err); return; }

  // User-initiated interrupt: the turn was killed on purpose, so the signal
  // exit must NOT read as a crash. Land the card in `review` (turn ended,
  // human to assess) and clear the marker. Skip if the user already pushed it
  // to a terminal state in the meantime.
  if (deps.interruptedCards && deps.interruptedCards.has(cardId)) {
    deps.interruptedCards.delete(cardId);
    if (!['done', 'blocked', 'hold', 'invoice', 'invoiced', 'paid'].includes(card.status)) {
      const next = { ...card, status: 'review', updated_at: nowIso() };
      applyTimerTransition(card, next, nowIso);
      await atomicWriteJson(cardPath(cardId), next);
      console.log(`[queue] ${cardId} → review (interrupted by user)`);
    }
    await tickQueueAfterExit(card.parent_id, deps);
    return;
  }

  // Guard against double-resolve: if the user already moved this to a terminal
  // state manually (done/blocked/hold or the billing tail), don't overwrite
  // their decision from the exit callback.
  if (['done', 'blocked', 'hold', 'invoice', 'invoiced', 'paid'].includes(card.status)) {
    console.log(`[queue] ${cardId} already ${card.status} on exit (code=${code}); not changing`);
    await tickQueueAfterExit(card.parent_id, deps);
    return;
  }

  // A buffered follow-up may have already re-claimed the cwd for this same card
  // by the time we get here (releaseCwd → dispatchPendingForCwd runs before this
  // exit callback). If so, a new turn is starting now — don't bounce the card
  // through `review` in the gap; leave it `doing` so the chat reads as
  // continuously running. Only on a clean exit; a crash still surfaces.
  if (code === 0 && card.session_id && deps.bridge && typeof deps.bridge.whoHoldsCwd === 'function') {
    const cwd = card.location && card.location.cwd;
    const holder = cwd ? deps.bridge.whoHoldsCwd(cwd) : null;
    if (holder === `card:${cardId}` || holder === `card:${cardId} (queued)`) {
      console.log(`[queue] ${cardId} clean exit but a follow-up turn is starting — staying doing`);
      await tickQueueAfterExit(card.parent_id, deps);
      return;
    }
  }

  if (code !== 0) {
    const next = { ...card, status: 'blocked', updated_at: nowIso() };
    applyTimerTransition(card, next, nowIso);
    await atomicWriteJson(cardPath(cardId), next);
    console.log(`[queue] ${cardId} blocked (claude exit ${code})`);
    await tickQueueAfterExit(card.parent_id, deps);
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
    applyTimerTransition(card, next, nowIso);
    await atomicWriteJson(cardPath(cardId), next);
    console.log(`[queue] ${cardId} blocked (acceptance check FAILED)`);
    await tickQueueAfterExit(card.parent_id, deps);
    return;
  }

  // Success path: every AI turn lands the card in `review` for human
  // assessment. `done` is a human-only transition. runn_mode only controls
  // walker continuation (siblings advance past `review` just like `done`),
  // not the human gate.
  const settled = {
    ...card,
    status: 'review',
    notes_md: check.skipped ? card.notes_md : appendCheckLog(card.notes_md, 'PASS', check.output),
    updated_at: nowIso(),
  };
  applyTimerTransition(card, settled, nowIso);
  await atomicWriteJson(cardPath(cardId), settled);
  console.log(`[queue] ${cardId} → review${check.skipped ? '' : ' (acceptance check PASS)'}`);

  await tickQueueAfterExit(card.parent_id, deps);
}

// Standard post-exit tick: the holder's own parent queue plus a sweep of every
// other Runn-on project. The cwd lock just released, so other projects waiting
// on it should get a chance to spawn.
async function tickQueueAfterExit(parentId, deps) {
  if (parentId) await maybeAdvanceQueue(parentId, deps);
  await tickOtherProjects(parentId, deps);
}

// Walk every top-level project except `excludeParentId` and tick its queue.
// Used after a holder's exit so other projects waiting on the same cwd get a
// chance to pick up where they left off.
async function tickOtherProjects(excludeParentId, deps) {
  const { listCards } = deps;
  try {
    const all = await listCards();
    for (const c of all) {
      if (c.parent_id) continue; // top-level only
      if (c.id === excludeParentId) continue;
      if (!c.runn_mode) continue; // gated parents skip themselves; small saving
      await maybeAdvanceQueue(c.id, deps);
    }
  } catch (err) {
    console.error('[queue] tickOtherProjects failed', err);
  }
}

function appendCheckLog(notes, verdict, output) {
  const stamp = new Date().toISOString();
  const tail = (output || '').slice(-800);
  const block = `\n\n---\n[${stamp}] acceptance check: ${verdict}\n${tail}\n`;
  return (notes || '') + block;
}

// Walk siblings under `parentId` (sorted by sort_order) and advance the queue.
//
// Sequential model: every walk spawns at most one AI subprocess, since the
// tasks share a working tree. The walk is also gated on the parent's
// `runn_mode` flag — if the user has the project switched off, queued AI
// tasks sit untouched until they flip it back on. Status semantics:
//   - done                 → walk past
//   - hold                 → walk past (user-requested skip)
//   - doing                → HALT (one AI subprocess at a time)
//   - waiting              → HALT (a follow-up turn is buffered, about to run)
//   - blocked              → HALT (error state — surface it for the user)
//   - blocking + review    → HALT (human approval gate)
//   - blocking + queued    → spawn-if-AI (only if runn_mode), then HALT
//   - independent + review → walk past (no approval gate)
//   - independent + queued (human) → walk past
//   - queued (AI) + runn_mode → spawn it and HALT (next walk picks up next)
//   - queued (AI) + !runn_mode → HALT silently (project is paused)
// Legacy: cards with status='todo' are treated as 'queued'.
async function maybeAdvanceQueue(parentId, deps) {
  if (!parentId) return;
  const { listCards, readJson, cardPath } = deps;
  // Read the parent so we can honor its runn_mode switch. If the parent file
  // is missing/unreadable, treat as off — better to do nothing than spawn
  // against an unknown project.
  let parent = null;
  try { parent = await readJson(cardPath(parentId)); }
  catch { /* parent gone */ }
  const runnOn = !!(parent && parent.runn_mode);

  const all = await listCards();
  const siblings = all
    .filter(c => c.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order);

  for (const sib of siblings) {
    const status = sib.status === 'todo' ? 'queued' : sib.status;
    // Completed states the walker steps past: done/hold plus the conveyor's
    // billing tail (invoice/invoiced/paid all mean the task is finished).
    if (status === 'done' || status === 'hold' ||
        status === 'invoice' || status === 'invoiced' || status === 'paid') continue;

    // Anything mid-flight or in error halts the walk regardless of blocking.
    // `waiting` = a queued follow-up message buffered behind a busy cwd; it's
    // about to run, so treat it like `doing` for the sequential constraint.
    if (status === 'doing' || status === 'waiting') {
      console.log(`[queue] halting at ${sib.id} (status=${status} — sequential constraint)`);
      return;
    }
    if (status === 'blocked') {
      console.log(`[queue] halting at ${sib.id} (status=blocked)`);
      return;
    }

    if (status === 'review') {
      if (sib.blocking) {
        console.log(`[queue] halting at ${sib.id} (blocking, awaiting human review)`);
        return;
      }
      continue;
    }

    // status === 'queued'
    const assignee = sib.assignee || 'human';
    if (assignee === 'human') {
      if (sib.blocking) {
        console.log(`[queue] halting at human task ${sib.id} (blocking)`);
        return;
      }
      continue;
    }

    if (sib.session_id) {
      console.log(`[queue] halting at ${sib.id} (AI queued but already has session — defensive)`);
      return;
    }
    if (!runnOn) {
      console.log(`[queue] halting at ${sib.id} (parent runn_mode=off; project is paused)`);
      return;
    }
    await spawnSibling(sib, deps);
    return;
  }
}

// Spawn an AI session for a single sibling and write the resulting `doing`
// card back to disk. On failure, mark the card `blocked` so the user sees it.
async function spawnSibling(sib, deps) {
  const { bridge, onAiExit, atomicWriteJson, cardPath, nowIso, mintPermissionToken, resolveCardLocation, resolveCardPermissionMode, resolveCardSystemContext, cardAttachmentSpawnList } = deps;
  const location = resolveCardLocation ? await resolveCardLocation(sib) : (sib.location || bridge.DEFAULT_LOCATION);
  try {
    const permissionToken = mintPermissionToken ? mintPermissionToken(sib.id) : undefined;
    const permissionMode = resolveCardPermissionMode ? await resolveCardPermissionMode(sib) : 'default';
    const systemPromptAppend = resolveCardSystemContext ? await resolveCardSystemContext(sib) : null;
    const { session_id, session_path, location: resolvedLoc } = await bridge.spawnSession({
      title: sib.title,
      notes: sib.notes_md,
      attachments: cardAttachmentSpawnList ? cardAttachmentSpawnList(sib) : [],
      location,
      permissionToken,
      permissionMode,
      systemPromptAppend,
      holder: `card:${sib.id}`,
      onExit: (code) => onAiExit(sib.id, code),
    });
    const merged = {
      ...sib,
      status: 'doing',
      assignee: 'ai',
      session_id,
      session_path,
      origin: 'runn',
      updated_at: nowIso(),
    };
    applyTimerTransition(sib, merged, nowIso);
    await atomicWriteJson(cardPath(sib.id), merged);
    console.log(`[queue] auto-started ${sib.id} → session ${session_id.slice(0,8)}`);
  } catch (err) {
    // CWD_BUSY means another project is using the working tree right now.
    // Don't mark the card blocked — it's still a valid queued task; we just
    // need to wait. The walker will re-fire from the holder's exit handler
    // (handleAiExit → maybeAdvanceQueue across every parent that shares this
    // cwd is the eventual fix; for now, the holder's own queue tick will
    // free things up and any user action on this project re-pokes us).
    if (err && err.code === 'CWD_BUSY') {
      console.log(`[queue] skipping ${sib.id} — cwd held by ${err.holder}`);
      return;
    }
    console.error(`[queue] failed to auto-start ${sib.id}`, err);
    const blocked = { ...sib, status: 'blocked', updated_at: nowIso() };
    applyTimerTransition(sib, blocked, nowIso);
    await atomicWriteJson(cardPath(sib.id), blocked);
  }
}

module.exports = { handleAiExit, maybeAdvanceQueue, runAcceptanceCheck };
