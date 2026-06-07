'use strict';

// Shared filesystem JSON store. File-per-record under ~/runn-data, atomic
// writes (write .tmp then rename). No in-memory cache — every read hits disk;
// chokidar watchers in the server turn changes into WebSocket broadcasts.
// Carried over verbatim in spirit from the old card server so the rewritten
// server, jobs.js, and any client/invoice modules share one implementation.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME;
const DATA_ROOT = process.env.RUNN_DATA || path.join(HOME, 'runn-data');

async function readJson(p) {
  return JSON.parse(await fsp.readFile(p, 'utf8'));
}

async function readJsonOr(p, fallback) {
  try { return await readJson(p); } catch { return fallback; }
}

async function atomicWriteJson(p, data) {
  // Temp name must be unique PER WRITE, not just per process: two concurrent
  // writes to the same record in one process would otherwise share
  // `<p>.<pid>.tmp`, interleave into it, and rename a torn/invalid file into
  // place (corrupting the record).
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

// Record ids for a file-per-record dir: every `<id>.json`, with `<id>` returned.
// Tmp files and sibling files (e.g. `<id>.notes.md`) are excluded.
async function listJsonIds(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
}

module.exports = {
  HOME,
  DATA_ROOT,
  readJson,
  readJsonOr,
  atomicWriteJson,
  ensureDir,
  listJsonIds,
};
