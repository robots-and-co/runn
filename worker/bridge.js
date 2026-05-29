'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Permission server (always registered). Claude launches it per session over
// stdio and routes every Write/Edit/Bash permission check through it.
const MCP_SERVER_PATH = path.join(__dirname, 'mcp-permission.js');

// Per-client ops servers (CLIENT_OPS_MCP_DESIGN.md §8.7). The decision is one
// server per client (`lthcs-ops`, future `zis-ops`, …), selected by the
// session's cwd: a session in `/home/waz/projects/lthcs/...` gets the lthcs
// server in its MCP config; a session anywhere else (Runn itself, runn-data,
// an unmanaged dir) gets only the permission server. This narrows the
// model-visible tool surface per session AND scopes always-allow rules
// per-client via the MCP tool-name prefix (`mcp__lthcs-ops__…`). Add a new
// client by dropping a `<client>-ops.js` server and adding the entry here.
const CLIENT_OPS_SERVERS = {
  lthcs: path.join(__dirname, 'lthcs-ops.js'),
};
const PROJECTS_ROOT = path.join(process.env.HOME || '/home/waz', 'projects');

// Map a session cwd to a known client whose tree it sits in, or null. We
// require an exact `<projects>/<client>/...` prefix — the bare `projects`
// dir, runn-data cards, and unrelated trees all map to null.
function clientForCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const prefix = PROJECTS_ROOT + path.sep;
  if (!cwd.startsWith(prefix)) return null;
  const first = cwd.slice(prefix.length).split(path.sep)[0];
  if (!first) return null;
  return Object.prototype.hasOwnProperty.call(CLIENT_OPS_SERVERS, first) ? first : null;
}

// Per-cwd MCP config path. Keyed by the cwd slug (same scheme Claude Code
// uses for project dirs) so two concurrent sessions in different cwds never
// race on the same file. Idempotent: rewriting it with the same contents is
// a no-op for the running CLI, which reads it once at spawn.
function mcpConfigPathFor(cwd) {
  return path.join(os.tmpdir(), `runn-mcp-config-${cwdToSlug(cwd)}.json`);
}

function ensureMcpConfig(cwd) {
  const cfg = {
    mcpServers: {
      runn: {
        type: 'stdio',
        command: process.execPath, // node binary inside this container/runtime
        args: [MCP_SERVER_PATH],
      },
    },
  };
  const client = clientForCwd(cwd);
  if (client) {
    cfg.mcpServers[`${client}-ops`] = {
      type: 'stdio',
      command: process.execPath,
      args: [CLIENT_OPS_SERVERS[client]],
    };
  }
  const configPath = mcpConfigPathFor(cwd);
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return configPath;
}

const PERMISSION_TOOL_NAME = 'mcp__runn__ask_permission';

// Convert an absolute cwd to the slug Claude Code uses for its project dir.
// e.g. /home/waz/runn-data  →  -home-waz-runn-data
function cwdToSlug(cwd) {
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

function sessionPathFor(cwd, sessionId) {
  return path.join(process.env.HOME, '.claude', 'projects', cwdToSlug(cwd), `${sessionId}.jsonl`);
}

const DEFAULT_LOCATION = { type: 'local', cwd: path.join(process.env.HOME, 'runn-data') };

// ── Cross-cwd AI mutex ──────────────────────────────────────
// Every claude subprocess we spawn (initial spawnSession + each --resume
// sendMessage) writes against the cwd's working tree. Two subprocesses on
// the same cwd would clobber each other's edits, regardless of which project
// or task triggered them. This mutex enforces "one claude per cwd" globally,
// so the per-parent queue walker plus this guard together make the system
// clobber-safe across the whole worker.
const activeCwds = new Map(); // cwd → { holder: string, since: number }

// ── Running-child registry ──────────────────────────────────
// We hold each running claude child's handle keyed by session_id — the stable
// identity an interrupt targets (the cwd is ambiguous: a follow-up and the
// initial spawn can resolve it differently, and siblings share one). A
// user-initiated interrupt looks the child up and signals it, so an in-flight
// turn can be stopped (without this the child is detached + unref'd and
// unreachable). Entries are removed by each child's own exit handler.
const runningChildren = new Map(); // sessionId → { child, holder, cwd, since }
function registerChild(sessionId, child, holder, cwd) {
  if (!sessionId) return;
  runningChildren.set(sessionId, { child, holder: holder || '?', cwd, since: Date.now() });
}
function unregisterChild(sessionId, child) {
  // Only drop the entry if it's still ours — a fast follow-up turn may have
  // already registered a new child under the same session_id.
  const e = sessionId && runningChildren.get(sessionId);
  if (e && e.child === child) runningChildren.delete(sessionId);
}

// Signal the running claude child for a session to stop. A detached child is
// its own process-group leader, so kill the whole group (claude + its tool/MCP
// subprocesses) via the negative pid; fall back to the bare child on failure.
function killSession(sessionId) {
  const entry = runningChildren.get(sessionId);
  if (!entry) return { ok: false, reason: 'no_running_child' };
  const pid = entry.child.pid;
  let signalled = false;
  try { process.kill(-pid, 'SIGTERM'); signalled = true; }
  catch { try { entry.child.kill('SIGTERM'); signalled = true; } catch {} }
  return { ok: signalled, holder: entry.holder, pid };
}

// Drop any buffered follow-up turns for a session so a kill doesn't get
// immediately undone by dispatchPendingForCwd respawning the next one.
function clearPending(sessionId) {
  const q = pendingMessages.get(sessionId);
  const n = q ? q.length : 0;
  pendingMessages.delete(sessionId);
  return n;
}

// True while a claude child is actually running for this session — i.e. a turn
// is in flight. Used to refuse mutations (e.g. moving a task across cwds, which
// relocates its jsonl) that would yank the working tree out from under a live
// turn. Buffered-but-not-yet-dispatched follow-ups don't count as live here.
function isSessionLive(sessionId) {
  return !!sessionId && runningChildren.has(sessionId);
}

function claimCwd(cwd, holder) {
  if (activeCwds.has(cwd)) {
    const cur = activeCwds.get(cwd);
    const err = new Error(`cwd ${cwd} is busy: ${cur.holder}`);
    err.code = 'CWD_BUSY';
    err.holder = cur.holder;
    err.cwd = cwd;
    throw err;
  }
  activeCwds.set(cwd, { holder, since: Date.now() });
}
function releaseCwd(cwd) {
  activeCwds.delete(cwd);
  // (runningChildren is keyed by session_id and cleaned up in each child's exit
  // handler — nothing to drop here.)
  // After releasing the cwd, check if a queued message is waiting for it and
  // fire the next one. Wrapped so a dispatch failure can't poison the release
  // — the AI exit chain still needs to run cleanly.
  try { dispatchPendingForCwd(cwd); }
  catch (err) { console.error('[bridge] dispatchPendingForCwd threw', err); }
}
function whoHoldsCwd(cwd) {
  const cur = activeCwds.get(cwd);
  return cur ? cur.holder : null;
}

// ── Pending message buffer ──────────────────────────────────
// When a user sends a follow-up message while a session's cwd is busy (the
// previous turn is still mid-flight, or another project is holding the
// working tree), /message can enqueue here instead of bouncing with 409. On
// every cwd-free event, dispatchPendingForCwd looks for the first queued
// message destined for that cwd and dispatches it via sendMessage.
const pendingMessages = new Map(); // sessionId → [{ text, location, permissionToken, permissionMode, onStart, onExit, holder }]
function enqueueMessage(sessionId, params) {
  if (!pendingMessages.has(sessionId)) pendingMessages.set(sessionId, []);
  const q = pendingMessages.get(sessionId);
  q.push(params);
  return q.length;
}
function pendingMessageCount(sessionId) {
  const q = pendingMessages.get(sessionId);
  return q ? q.length : 0;
}
function dispatchPendingForCwd(cwd) {
  for (const [sessionId, queue] of pendingMessages.entries()) {
    if (!queue.length) continue;
    const next = queue[0];
    const nextCwd = next.location && next.location.cwd;
    if (nextCwd !== cwd) continue;
    queue.shift();
    if (queue.length === 0) pendingMessages.delete(sessionId);
    const onStart = next.onStart;
    // Strip onStart from params before forwarding to sendMessage (which doesn't
    // know about it). sendMessage resolves on init, so chaining .then here is
    // the right hook to mark the card as actually-running.
    const params = { ...next };
    delete params.onStart;
    sendMessage({ sessionId, ...params })
      .then(() => {
        if (typeof onStart === 'function') {
          try { onStart(); } catch (err) { console.error('[bridge] queued onStart threw', err); }
        }
      })
      .catch(err => {
        console.error(`[bridge] queued message dispatch failed for ${sessionId.slice(0,8)}`, err);
      });
    return; // one dispatch per cwd-free event
  }
}

// Spawn a fresh Claude session non-interactively. Resolves as soon as the
// init event arrives carrying the session_id; the child keeps running in
// the background and writes to its session jsonl, which Runn picks up via
// the discovery watcher.
// Always-on response-format directive, appended to every spawn AND re-asserted
// on every resume (claude --resume *replaces* the append, so the resume caller
// must pass the full context+directive or it's lost — see composeAppend callers).
// Runn collapses each reply to its trailing "TL;DR:" line in the transcript.
const TLDR_DIRECTIVE = [
  '# Response format',
  '',
  'Every message you send to the human must end with a one-line summary, on its',
  'own final line, in exactly this form:',
  '',
  'TL;DR: <one plain-English sentence, 15 words or fewer>',
  '',
  'This applies to EVERY reply addressed to the human — answers, recommendations,',
  'and messages that ask the human a question or propose next steps. When you are',
  'asking the human something, the TL;DR states that question or the decision you',
  'need (e.g. "TL;DR: Bare metal is simpler — want me to proceed?"). The ONLY',
  'messages without a TL;DR are intermediate progress notes written between tool',
  'calls while you are still working; the final message of your turn always has one.',
  '',
  'Runn collapses your reply to this single line (a chevron expands the rest), so',
  'write it to stand on its own for a reader who never expands the detail.',
].join('\n');

// Combine the per-card context (client/project notes, or null) with the always-on
// directive into one --append-system-prompt value.
function composeAppend(systemPromptAppend) {
  const parts = [];
  if (systemPromptAppend && String(systemPromptAppend).trim()) parts.push(String(systemPromptAppend).trim());
  parts.push(TLDR_DIRECTIVE);
  return parts.join('\n\n');
}

// Build the <RUNN-ATTACHMENTS> marker block from a card's sidecar attachments
// (or the saveAttachments() output) — each entry needs { absPath, mime }. This
// is the single source of truth for the marker format; server.js delegates here
// for the live /message path too, and the frontend's parseUserAttachments() is
// its inverse. Returns '' when there's nothing to attach.
function attachmentsMarker(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const lines = attachments.map(a => `- ${a.absPath} (${a.mime})`).join('\n');
  return `<RUNN-ATTACHMENTS>\n${lines}\n</RUNN-ATTACHMENTS>`;
}

function spawnSession({ title, notes, location, permissionToken, permissionMode, systemPromptAppend, onExit, holder, attachments }) {
  location = location || DEFAULT_LOCATION;
  if (location.type === 'ssh') {
    return Promise.reject(new Error('SSH transport not yet implemented — see slice 2d'));
  }
  if (location.type !== 'local') {
    return Promise.reject(new Error(`unknown location.type: ${location.type}`));
  }
  const cwd = location.cwd;
  // Claim the cwd before spawning — synchronous so two concurrent calls
  // can't both pass the check. Released when the child exits (the wrapped
  // onExit below).
  try { claimCwd(cwd, holder || 'spawnSession'); }
  catch (err) { return Promise.reject(err); }
  // Write the per-cwd MCP config now — this picks the matching <client>-ops
  // server (if any) for the session's tree. Done before the spawn so the CLI
  // reads it directly from --mcp-config below.
  const mcpConfigPath = ensureMcpConfig(cwd);
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpConfigPath,
      '--permission-prompt-tool', PERMISSION_TOOL_NAME,
    ];
    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }
    args.push('--append-system-prompt', composeAppend(systemPromptAppend));
    // Sidecar attachments laid up before the task ran ride along here: their
    // marker block is prepended so the spawn prompt points Claude at the files
    // (same contract as the live /message path). "The image goes with it."
    let prompt = (notes && String(notes).trim()) ? `${title}\n\n${String(notes).trim()}` : (title || '');
    const marker = attachmentsMarker(attachments);
    if (marker) {
      const body = prompt.trim() || 'Please analyse the attached file(s).';
      prompt = `${marker}\n\n${body}`;
    }
    args.push('--print', prompt);
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: {
        ...process.env,
        // The MCP server reads these to find the worker and identify this spawn.
        RUNN_PORT: process.env.PORT || '17777',
        RUNN_PERMISSION_TOKEN: permissionToken || '',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // session_id isn't known until the init event; capture it here so both the
    // registry (for interrupts) and the exit cleanup can key off it.
    let mySessionId = null;

    // Attach exit listener BEFORE unref so it still fires while the worker is alive.
    // Release the cwd lock on exit so the next sibling / project / message can spawn.
    child.on('exit', (code) => {
      unregisterChild(mySessionId, child);
      releaseCwd(cwd);
      if (typeof onExit === 'function') {
        try { onExit(code); } catch (err) { console.error('[bridge] onExit threw', err); }
      }
    });

    let resolved = false;
    const rl = readline.createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      if (resolved) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          resolved = true;
          rl.removeAllListeners('line');
          // Drain stdout/stderr so the child doesn't block on full pipe buffers.
          child.stdout.on('data', () => {});
          child.stderr.on('data', () => {});
          child.unref();
          const resolvedCwd = ev.cwd || cwd;
          // Hold the handle so an interrupt can reach this child by session_id.
          mySessionId = ev.session_id;
          registerChild(ev.session_id, child, holder || 'spawnSession', resolvedCwd);
          resolve({
            session_id: ev.session_id,
            location: { type: 'local', cwd: resolvedCwd },
            session_path: sessionPathFor(resolvedCwd, ev.session_id),
          });
        }
      } catch { /* skip non-JSON lines */ }
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      releaseCwd(cwd);
      reject(err);
    });

    child.stderr.on('data', (chunk) => {
      if (!resolved) console.error('[bridge stderr]', chunk.toString().slice(0, 500));
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      // SIGTERM should trigger child 'exit' → releaseCwd; if it doesn't, this
      // belt-and-braces release prevents the cwd from being permanently stuck.
      try { child.kill('SIGTERM'); } catch {}
      releaseCwd(cwd);
      reject(new Error('bridge: no session_id received within 30s'));
    }, 30000);
  });
}

// Send a follow-up message to an existing session via `claude --resume`.
// Resolves once the child process has produced its init event (i.e. it's
// actually running and writing to the session jsonl), then lets it run
// detached. The chokidar watcher catches the resulting jsonl writes and
// broadcasts session.updated → the panel refreshes.
function sendMessage({ sessionId, text, location, permissionToken, permissionMode, systemPromptAppend, onExit, holder }) {
  location = location || DEFAULT_LOCATION;
  if (location.type !== 'local') {
    return Promise.reject(new Error(`sendMessage: only local sessions supported (got ${location.type})`));
  }
  const cwd = location.cwd;
  try { claimCwd(cwd, holder || `sendMessage:${sessionId.slice(0,8)}`); }
  catch (err) { return Promise.reject(err); }
  // Re-write the per-cwd MCP config — idempotent for unchanged cwds, but the
  // resume target's cwd is always authoritative (the same client mapping
  // applies whether this is a spawn or a follow-up turn).
  const mcpConfigPath = ensureMcpConfig(cwd);
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpConfigPath,
      '--permission-prompt-tool', PERMISSION_TOOL_NAME,
    ];
    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
    }
    // --resume *replaces* the appended system prompt, so re-assert the full
    // context+directive here or the session would lose it on every follow-up.
    args.push('--append-system-prompt', composeAppend(systemPromptAppend));
    args.push('--resume', sessionId, '--print', text);
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: {
        ...process.env,
        RUNN_PORT: process.env.PORT || '17777',
        RUNN_PERMISSION_TOKEN: permissionToken || '',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Hold the handle so an interrupt can reach this child by session_id.
    registerChild(sessionId, child, holder || `sendMessage:${sessionId.slice(0,8)}`, cwd);

    // Release the cwd lock + fire caller's onExit when the --resume claude exits.
    child.on('exit', (code) => {
      unregisterChild(sessionId, child);
      releaseCwd(cwd);
      if (typeof onExit === 'function') {
        try { onExit(code); } catch (err) { console.error('[bridge] sendMessage onExit threw', err); }
      }
    });

    let resolved = false;
    const rl = readline.createInterface({ input: child.stdout });
    let stderrBuf = '';

    rl.on('line', (line) => {
      if (resolved) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'system' && ev.subtype === 'init') {
          resolved = true;
          rl.removeAllListeners('line');
          child.stdout.on('data', () => {});
          child.stderr.on('data', () => {});
          child.unref();
          resolve({ ok: true });
        }
      } catch { /* skip */ }
    });

    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      // The 'exit' handler may not fire on spawn error; release defensively.
      releaseCwd(cwd);
      reject(err);
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`claude exited ${code} before init: ${stderrBuf.slice(0, 500)}`));
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch {}
      releaseCwd(cwd);
      reject(new Error('bridge sendMessage: no init within 30s'));
    }, 30000);
  });
}

module.exports = {
  spawnSession,
  sendMessage,
  attachmentsMarker,
  sessionPathFor,
  cwdToSlug,
  DEFAULT_LOCATION,
  whoHoldsCwd,
  enqueueMessage,
  pendingMessageCount,
  killSession,
  clearPending,
  isSessionLive,
  clientForCwd,
  ensureMcpConfig,
  mcpConfigPathFor,
};
