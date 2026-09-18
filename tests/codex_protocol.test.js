const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(__dirname, 'fixtures', 'codex');

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
}

test('success fixture preserves JSON-RPC responses and streaming events', () => {
  const messages = readFixture('success.jsonl');
  assert.equal(messages[0].method, 'initialize');
  assert.equal(messages.find((m) => m.id === 1 && m.result).result.platformFamily, 'unix');
  assert.equal(messages.find((m) => m.method === 'agent/message/delta').params.delta, 'Hi');
  assert.equal(messages.find((m) => m.method === 'turn/completed').params.turn.status, 'completed');
});

test('error fixture distinguishes auth, child, and terminal turn failures', () => {
  const messages = readFixture('errors.jsonl');
  assert.equal(messages.find((m) => m.id === 2).result.requiresOpenaiAuth, true);
  assert.equal(messages.find((m) => m.id === 3).error.code, -32603);
  assert.equal(messages.find((m) => m.method === 'turn/completed').params.turn.status, 'failed');
  assert.equal(messages.find((m) => m.method === 'process/exited').params.exitCode, 1);
});

test('unknown notifications are forward-compatible diagnostics', () => {
  const messages = readFixture('unknown.jsonl');
  const unknown = messages.find((m) => m.method === 'future/event');
  assert.ok(unknown);
  assert.deepEqual(unknown.params, { preserved: true });
});
