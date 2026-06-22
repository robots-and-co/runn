#!/usr/bin/env node
'use strict';

// Minimal stdio MCP server that exposes one tool: `ask_permission`.
// Claude calls it via `--permission-prompt-tool mcp__runn__ask_permission`
// every time it wants to use Write/Edit/Bash/etc. We forward the request to
// the Runn worker over HTTP, which parks it, broadcasts it to the chat UI,
// and replies when the user clicks Allow/Deny.

const readline = require('readline');
const http = require('http');

const RUNN_PORT  = process.env.RUNN_PORT  || '17778';
const RUNN_HOST  = process.env.RUNN_HOST  || '127.0.0.1';
const REQ_TOKEN  = process.env.RUNN_PERMISSION_TOKEN || '';

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function askWorker(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: RUNN_HOST, port: RUNN_PORT,
      path: '/permissions/request', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`bad worker response: ${body.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    // No timeout — the worker holds the request open until the user decides.
    req.write(data);
    req.end();
  });
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'runn-permissions', version: '0.1.0' },
    }});
    return;
  }
  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{
        name: 'ask_permission',
        description: 'Ask the Runn user whether Claude may use a particular tool.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input:     { type: 'object', additionalProperties: true },
          },
          required: ['tool_name', 'input'],
        },
      }],
    }});
    return;
  }

  if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    try {
      const decision = await askWorker({
        token: REQ_TOKEN,
        tool_name: args.tool_name,
        input: args.input || {},
      });
      // Claude expects the tool result body to be a JSON-encoded text block
      // matching the permission-prompt-tool contract.
      const payload = (decision && decision.behavior === 'allow')
        ? { behavior: 'allow', updatedInput: args.input || {} }
        : { behavior: 'deny',  message: (decision && decision.message) || 'denied by user' };
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }});
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: `runn permission bridge error: ${err.message || err}` }) }],
      }});
    }
    return;
  }

  // Unknown method — return method-not-found so Claude doesn't hang.
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' }});
  }
});
