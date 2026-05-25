'use strict';

// ─────────────────────────────────────────────────────────────────────────
// SKETCH — non-blocking cron tasks.  NOT WIRED IN YET.
//
// A "cron card" recurs on a schedule instead of riding the queued→doing→review
// →done conveyor once. It runs in a READ-ONLY parallel lane: a one-shot
// `claude -p` that cannot mutate the working tree, so it never takes the cwd
// lock (`bridge.claimCwd`) and can run alongside the main queue and other
// crons. This is the safe relaxation of the per-cwd rule — see the
// [[project-no-parallel-ai]] invariant: never two *writers* in one tree.
//
// History is NOT Claude session continuity. Each fire is ephemeral (no
// --resume). The card carries a capped `runs[]` log; the task panel renders
// that instead of a chat transcript. "Alert if changed" crons get the previous
// run's summary injected into the prompt prefix.
//
// Cron cards live OUTSIDE the conveyor: `queue.js` maybeAdvanceQueue must skip
// any card with `cron` (a TODO over there, not here), so they never halt the
// walker.
//
// ── Card shape this module reads/writes ──────────────────────────────────
//   card.cron  = { preset: 'weekdays 0900',     // human string the user typed
//                  descriptor: {…},             // normalized (parsePreset)
//                  enabled: true,
//                  next_run: <iso>,             // we compute + persist
//                  last_run: <iso> }
//   card.runs  = [ { ts, ok, summary, alerted } ]   // capped to RUNS_KEEP
//   card.alert = { active, summary, ts }             // orthogonal to status
//
// ── DECISIONS STILL OPEN (flagged inline as TUNABLE / VERIFY) ─────────────
//  * cwd: anchor in the client workspace (CLAUDE.md context) but never lock,
//    vs. an ephemeral temp dir (true isolation, no context). Sketch does the
//    former. TUNABLE.
//  * read-only flag: the exact CLI flag to forbid Edit/Write must be VERIFIED
//    against the installed `claude` (see buildReadOnlyArgs).
//  * Bash stays allowed — SSH/curl crons need it. So "read-only" means "the
//    file-mutating tools are off + not anchored as a lock holder", not "no
//    side effects anywhere". Honest gap; acceptable for our use cases.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const readline = require('readline');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const RUN_TIMEOUT_MS = 5 * 60 * 1000;   // a cron run that hangs gets killed
const RUNS_KEEP = 20;                   // cap on the per-card run log

// ── Preset parsing ────────────────────────────────────────────────────────
// Presets only (no raw 5-field cron). Returns a normalized descriptor or null.
//   'hourly'             → { kind: 'interval', everyMs: 3_600_000 }
//   'every 15m'          → { kind: 'interval', everyMs: 900_000 }
//   'every 2h'           → { kind: 'interval', everyMs: 7_200_000 }
//   'daily 9am'          → { kind: 'clock', dows: null,       h, m }
//   'weekdays 0900'      → { kind: 'clock', dows: [1,2,3,4,5], h, m }
//   'weekly mon 9am'     → { kind: 'clock', dows: [1],        h, m }
// Times are LOCAL to the container TZ. TUNABLE: add 'monthly', explicit TZ.
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseTime(tok) {
  // '9am' | '0900' | '9:30pm' | '21:00' → { h, m } or null
  let mm = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/i.exec(tok.trim());
  if (!mm) return null;
  let h = +mm[1], m = mm[2] ? +mm[2] : 0;
  const ap = mm[3] && mm[3].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return { h, m };
}

function parsePreset(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'hourly') return { kind: 'interval', everyMs: 3600_000 };
  let mm = /^every\s+(\d+)\s*(m|h)$/.exec(s);
  if (mm) return { kind: 'interval', everyMs: +mm[1] * (mm[2] === 'h' ? 3600_000 : 60_000) };
  mm = /^daily\s+(.+)$/.exec(s);
  if (mm) { const t = parseTime(mm[1]); return t && { kind: 'clock', dows: null, ...t }; }
  mm = /^weekdays\s+(.+)$/.exec(s);
  if (mm) { const t = parseTime(mm[1]); return t && { kind: 'clock', dows: [1, 2, 3, 4, 5], ...t }; }
  mm = /^weekly\s+(\w{3})\w*\s+(.+)$/.exec(s);
  if (mm && mm[1] in DOW) { const t = parseTime(mm[2]); return t && { kind: 'clock', dows: [DOW[mm[1]]], ...t }; }
  return null;
}

// Next fire strictly after `from` (a Date), as epoch ms.
function computeNextRun(descriptor, from = new Date()) {
  if (!descriptor) return null;
  if (descriptor.kind === 'interval') return from.getTime() + descriptor.everyMs;
  // clock: scan forward up to 8 days for the next matching dow+time
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(descriptor.h, descriptor.m, 0, 0);
  for (let i = 0; i <= 8; i++) {
    if (d.getTime() > from.getTime() &&
        (!descriptor.dows || descriptor.dows.includes(d.getDay()))) {
      return d.getTime();
    }
    d.setDate(d.getDate() + 1);
    d.setHours(descriptor.h, descriptor.m, 0, 0);
  }
  return null; // unreachable for valid descriptors
}

// ── The read-only one-shot runner ───────────────────────────────────────
// Models queue.js runPromptCheck: spawn `claude -p`, capture stdout, NO
// claimCwd, NO session registration in bridge. Two differences:
//  1. Read-only flags (buildReadOnlyArgs) so it can't edit the tree.
//  2. We sniff the init event for session_id and hand it to deps.markCronSession
//     so the discovery watcher (adoptSession) doesn't turn the run's jsonl into
//     a stray card. THIS IS REQUIRED — without it every fire spawns a junk card.
function buildReadOnlyArgs(prompt, systemPromptAppend) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  // VERIFY against installed CLI. Intent: forbid the working-tree mutators,
  // keep Bash (SSH/curl crons need it). Likely one of:
  //   --disallowedTools Edit Write NotebookEdit
  //   --permission-mode plan        (may be too restrictive — blocks Bash too)
  args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit');
  if (systemPromptAppend && String(systemPromptAppend).trim()) {
    args.push('--append-system-prompt', String(systemPromptAppend).trim());
  }
  args.push('--print', prompt);
  return args;
}

function runOnce({ prompt, cwd, systemPromptAppend, onSessionId }) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, buildReadOnlyArgs(prompt, systemPromptAppend), {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '', err = '', done = false;
    const finish = (ok, output, code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ ok, output: (output || '').trim(), code });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(false, `${out}\n${err}\n[cron run: timed out after ${RUN_TIMEOUT_MS}ms]`, -1);
    }, RUN_TIMEOUT_MS);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id && onSessionId) {
          onSessionId(ev.session_id); // register so adoptSession skips it
        }
      } catch { /* non-JSON line, ignore */ }
      out += line + '\n';
    });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('exit', (code) => finish(code === 0, `${out}\n${err}`, code));
    child.on('error', (e) => finish(false, String(e.message || e), -1));
  });
}

// Trailing-marker parse, mirroring runPromptCheck's PASS sniff. Cron prompts
// are instructed to end with `ALERT: <reason>` or `OK`. Anything else (or a
// crash) is treated as an alert so failures surface rather than going silent.
function parseVerdict(output, code) {
  if (code !== 0) return { alert: true, summary: 'run failed (non-zero exit)' };
  const lines = (output || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
    const l = lines[i].trim();
    let mm = /^ALERT:\s*(.+)$/i.exec(l);
    if (mm) return { alert: true, summary: mm[1].slice(0, 280) };
    if (/^OK\b/i.test(l)) return { alert: false, summary: l.slice(0, 280) };
  }
  // No marker at all → surface it; the prompt didn't follow the contract.
  return { alert: true, summary: 'no ALERT/OK marker in output' };
}

// ── Per-card fire ─────────────────────────────────────────────────────────
async function fireCron(cardId, deps) {
  const { readJson, atomicWriteJson, cardPath, nowIso,
          resolveCardLocation, resolveCardSystemContext, broadcast, markCronSession } = deps;

  let card;
  try { card = await readJson(cardPath(cardId)); }
  catch { return; }                                   // deleted between schedule and fire
  if (!card.cron || !card.cron.enabled) return;       // disabled while we waited

  // Overlap guard: never two copies of the same cron card in flight.
  if (running.has(cardId)) {
    console.log(`[cron] ${cardId} still running — skipping this tick`);
    return scheduleCard(card, deps);                  // try again next slot
  }
  running.add(cardId);

  try {
    const loc = resolveCardLocation ? await resolveCardLocation(card) : null;  // context only; NOT locked
    const ctx = resolveCardSystemContext ? await resolveCardSystemContext(card) : null;
    const prev = (card.runs && card.runs[0]) || null;
    const prompt = [
      card.title,
      card.notes_md && String(card.notes_md).trim(),
      prev && `\n(Previous run @ ${prev.ts}: ${prev.summary})`,
      '\nEnd your reply with exactly one line: `ALERT: <reason>` if a human '
        + 'should look, otherwise `OK`.',
    ].filter(Boolean).join('\n\n');

    const res = await runOnce({
      prompt,
      cwd: loc && loc.cwd,
      systemPromptAppend: ctx,
      onSessionId: (sid) => { if (markCronSession) markCronSession(sid, cardId); },
    });
    const verdict = parseVerdict(res.output, res.code);
    const ts = nowIso();

    const fresh = await readJson(cardPath(cardId)).catch(() => card);
    const runs = [{ ts, ok: res.ok, summary: verdict.summary, alerted: verdict.alert },
                  ...(fresh.runs || [])].slice(0, RUNS_KEEP);
    const next = {
      ...fresh,
      runs,
      cron: { ...fresh.cron, last_run: ts,
              next_run: new Date(computeNextRun(fresh.cron.descriptor)).toISOString() },
      // alert is orthogonal to status — we never touch fresh.status here.
      alert: verdict.alert ? { active: true, summary: verdict.summary, ts } : fresh.alert,
      updated_at: ts,
    };
    await atomicWriteJson(cardPath(cardId), next);     // auto-broadcasts card.changed
    if (verdict.alert && broadcast) {
      broadcast({ type: 'cron.alert', card_id: cardId, summary: verdict.summary, ts });
    }
    console.log(`[cron] ${cardId} ran (${verdict.alert ? 'ALERT' : 'ok'}): ${verdict.summary}`);
    scheduleCard(next, deps);
  } catch (err) {
    console.error(`[cron] ${cardId} fire failed`, err);
    scheduleCard(card, deps);                          // keep the schedule alive
  } finally {
    running.delete(cardId);
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────
const timers = new Map();   // cardId → timeout handle
const running = new Set();  // cardId currently firing (overlap guard)

function scheduleCard(card, deps) {
  clearCard(card.id);
  if (!card.cron || !card.cron.enabled || !card.cron.descriptor) return;
  const at = computeNextRun(card.cron.descriptor);
  if (!at) return;
  const delay = Math.max(0, at - Date.now());
  // setTimeout caps at ~24.8 days; for longer waits re-arm. (Presets never
  // exceed a week, so this is belt-and-suspenders.)
  const MAX = 2_147_000_000;
  const handle = setTimeout(
    () => (delay > MAX ? scheduleCard(card, deps) : fireCron(card.id, deps)),
    Math.min(delay, MAX),
  );
  timers.set(card.id, handle);
}

function clearCard(cardId) {
  const h = timers.get(cardId);
  if (h) { clearTimeout(h); timers.delete(cardId); }
}

// Boot: rebuild all timers from disk. Called once after migrations, before/at
// server.listen() (worker restarts on `docker restart runn`, so in-memory
// timers MUST be reconstructed from the persisted card.cron fields).
async function start(deps) {
  const all = await deps.listCards();
  let n = 0;
  for (const c of all) {
    if (c.cron && c.cron.enabled && c.cron.descriptor) { scheduleCard(c, deps); n++; }
  }
  console.log(`[cron] scheduled ${n} cron card(s)`);
}

// Called by server.js when a card is created/changed/removed (it already gets
// these via the cardsWatcher) so add/edit/disable/delete re-arms or cancels.
function onCardChanged(card, deps) {
  if (!card) return;
  if (card.cron && card.cron.enabled && card.cron.descriptor) scheduleCard(card, deps);
  else clearCard(card.id);
}
function onCardRemoved(cardId) { clearCard(cardId); }

module.exports = { parsePreset, computeNextRun, start, onCardChanged, onCardRemoved };
