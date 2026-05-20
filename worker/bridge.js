'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Convert an absolute cwd to the slug Claude Code uses for its project dir.
// e.g. /home/waz/runn-data  →  -home-waz-runn-data
function cwdToSlug(cwd) {
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

function sessionPathFor(cwd, sessionId) {
  return path.join(process.env.HOME, '.claude', 'projects', cwdToSlug(cwd), `${sessionId}.jsonl`);
}

const DEFAULT_LOCATION = { type: 'local', cwd: path.join(process.env.HOME, 'runn-data') };

// Spawn a fresh Claude session non-interactively. Resolves as soon as the
// init event arrives carrying the session_id; the child keeps running in
// the background and writes to its session jsonl, which Runn picks up via
// the discovery watcher.
function spawnSession({ title, location, onExit }) {
  location = location || DEFAULT_LOCATION;
  if (location.type === 'ssh') {
    return Promise.reject(new Error('SSH transport not yet implemented — see slice 2d'));
  }
  if (location.type !== 'local') {
    return Promise.reject(new Error(`unknown location.type: ${location.type}`));
  }
  const cwd = location.cwd;
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--print', title,
    ], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Attach exit listener BEFORE unref so it still fires while the worker is alive.
    if (typeof onExit === 'function') {
      child.on('exit', (code) => { try { onExit(code); } catch (err) { console.error('[bridge] onExit threw', err); } });
    }

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
      reject(err);
    });

    child.stderr.on('data', (chunk) => {
      if (!resolved) console.error('[bridge stderr]', chunk.toString().slice(0, 500));
    });

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('bridge: no session_id received within 30s'));
    }, 30000);
  });
}

// Send a follow-up message to an existing session via `claude --resume`.
// Resolves once the child process has produced its init event (i.e. it's
// actually running and writing to the session jsonl), then lets it run
// detached. The chokidar watcher catches the resulting jsonl writes and
// broadcasts session.updated → the panel refreshes.
function sendMessage({ sessionId, text, location }) {
  location = location || DEFAULT_LOCATION;
  if (location.type !== 'local') {
    return Promise.reject(new Error(`sendMessage: only local sessions supported (got ${location.type})`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--resume', sessionId,
      '--print', text,
    ], {
      cwd: location.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      reject(new Error('bridge sendMessage: no init within 30s'));
    }, 30000);
  });
}

module.exports = { spawnSession, sendMessage, sessionPathFor, cwdToSlug, DEFAULT_LOCATION };
