#!/usr/bin/env node
// Credential-free protocol smoke: initialization, account status, thread start,
// turn start, and interruption. It intentionally does not invoke a model.
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');

const codexHome = fs.mkdtempSync(`${os.tmpdir()}/lattice-codex-home-`);
const child = spawn('codex', ['app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: codexHome },
});

let buffer = '';
let threadId;
let turnId;
let interrupted = false;
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} });
      send({ jsonrpc: '2.0', id: 3, method: 'thread/start', params: {
        cwd: process.cwd(), ephemeral: true, sandbox: 'read-only',
      } });
    }
    if (message.id === 2) {
      if (message.result?.requiresOpenaiAuth !== true) throw new Error('expected unauthenticated smoke account');
    }
    if (message.id === 3) {
      if (message.error) throw new Error(`thread/start failed: ${message.error.message}`);
      threadId = message.result.thread.id;
      send({ jsonrpc: '2.0', id: 4, method: 'turn/start', params: {
        threadId, input: [{ type: 'text', text: 'credential-free smoke' }],
      } });
    }
    if (message.method === 'turn/started') {
      turnId = message.params.turn.id;
      send({ jsonrpc: '2.0', id: 5, method: 'turn/interrupt', params: { threadId, turnId } });
    }
    if (message.method === 'turn/completed') {
      if (message.params.turn.status !== 'interrupted') throw new Error('expected interrupted turn');
      interrupted = true;
      child.kill();
    }
  }
});
child.stderr.on('data', () => {});
child.on('error', (error) => { throw error; });
child.on('close', (code) => {
  fs.rmSync(codexHome, { recursive: true, force: true });
  if (!interrupted) process.exitCode = 1;
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  clientInfo: { name: 'lattice-contract-smoke', version: '0.1.0' },
} });
