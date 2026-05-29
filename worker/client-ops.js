#!/usr/bin/env node
'use strict';

// Stdio MCP server that will expose the curated `client-ops` tool surface —
// the boundary that holds real client hostnames/IPs/creds on-box and only
// hands the model abstract args + sanitised results (see CLIENT_OPS_MCP_DESIGN.md).
//
// Boot order matters: we load the site/secret config *before* completing the
// MCP handshake so a missing or malformed config is a loud failure (non-zero
// exit + stderr) rather than a server with no sites that silently accepts
// tool calls it can't fulfil.
//
// Approval flow for mutating tools (design doc §4): the Claude CLI is spawned
// with `--permission-prompt-tool mcp__runn__ask_permission`, which routes
// EVERY tool call — including mcp__client-ops__* — through worker/mcp-permission.js
// before this handler runs. That tool posts to /permissions/request on the
// worker, parking the call until the operator clicks Allow/Deny. By the time
// `tools/call` reaches us here, the gate has already fired; a denied call
// never arrives. We therefore do NOT reinvent the gate — we lean on it and
// add a stderr audit line for every mutating call as a belt-and-braces record.
// Defence-in-depth (server-side self-gating of mutations) is the open
// question §8.3; the CATEGORY field on each tool is the hook for that work
// if/when it's answered.

const readline = require('readline');
const { loadConfig, ClientOpsConfigError } = require('./client-ops-config');
const toolRegistry = require('./client-ops-tools');

let SITES;
let SITE_NAMES;
try {
  const cfg = loadConfig();
  SITES = cfg.sites;
  SITE_NAMES = Object.keys(SITES);
  // Stderr is safe to write to in a stdio MCP server (stdout is JSON-RPC).
  // We log the count only — site names and values must never leave the box
  // via a transcript or log file the model can read.
  process.stderr.write(
    `client-ops: loaded ${SITE_NAMES.length} site(s) from ${cfg.configPath}\n`
  );
} catch (err) {
  const where = err instanceof ClientOpsConfigError ? '' : ` (${err.name})`;
  process.stderr.write(`client-ops: refusing to start${where}: ${err.message}\n`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'client-ops', version: '0.1.0' },
    }});
    return;
  }
  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: toolRegistry.listForMcp(SITE_NAMES),
    }});
    return;
  }

  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    const tool = toolRegistry.findByName(params.name);
    if (!tool) {
      send({ jsonrpc: '2.0', id: msg.id, error: {
        code: -32601,
        message: `client-ops: no such tool: ${params.name || '?'}`,
      }});
      return;
    }
    // Audit line for mutating tools — the CLI's permission-prompt gate has
    // already fired at this point, so reaching here means the operator
    // clicked Allow. We log only the site label (abstract) — never the
    // resolved host/user/key — and let the tool's own handler log any
    // operator-readable detail like `reason`.
    if (tool.CATEGORY === 'mutating') {
      const siteArg = (params.arguments && params.arguments.site) || null;
      process.stderr.write(
        `client-ops: MUTATING tool=${tool.NAME} site=${JSON.stringify(siteArg)}\n`
      );
    }
    let result;
    try {
      result = await tool.handler(params.arguments || {}, { sites: SITES });
    } catch (err) {
      // Handler exceptions must never expose host/key paths via err.message.
      // We log the real cause to stderr (stays on box) and return an opaque
      // error code to the model.
      process.stderr.write(
        `client-ops: tool ${tool.NAME} threw: ${err && err.message ? err.message : err}\n`
      );
      result = { error: 'internal_error' };
    }
    // MCP tool results are content blocks; we JSON-encode the structured
    // result into a single text block (same shape as mcp-permission.js).
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }});
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' }});
  }
});

// Parent claude exits → our stdin closes → exit cleanly so we don't linger.
rl.on('close', () => process.exit(0));
