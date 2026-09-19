import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VaultRepository, RepositoryError, TransactionError, WriterLockError } from '../runtime/vault/repository.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'vault');
const lockHolder = path.join(here, 'fixtures', 'persistence', 'lock-holder.mjs');

async function fixture() {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-acceptance-'));
  const root = path.join(container, 'vault');
  const stateRoot = path.join(container, 'state');
  await fs.cp(fixtureRoot, root, { recursive: true });
  await fs.mkdir(stateRoot);
  return { container, root, stateRoot };
}

async function cleanup(item) { await fs.rm(item.container, { recursive: true, force: true }); }

async function proposal(repository, marker, { checkpoint = true } = {}) {
  const snapshot = await repository.snapshot('complete-topic');
  const state = structuredClone(snapshot.state);
  state.futureTopLevelField.testMarker = marker;
  const note = snapshot.notes[0];
  const files = [
    { relativePath: snapshot.statePath, content: '' },
    { relativePath: note.index.path, content: `${note.body}\n\n${marker}\n` },
  ];
  const expectedRevisions = { [snapshot.statePath]: snapshot.stateRevision, [note.index.path]: note.revision };
  if (checkpoint) {
    const id = `session-${marker}`;
    const checkpointPath = `topics/complete-topic/sessions/${id}.md`;
    state.sessions[id] = { id, path: checkpointPath, createdAt: '2026-09-19T00:00:00.000Z' };
    files.push({ relativePath: checkpointPath, content: `# ${marker}\n` });
    expectedRevisions[checkpointPath] = null;
  }
  files[0].content = `${JSON.stringify(state, null, 2)}\n`;
  return { snapshot, state, files, expectedRevisions };
}

function commitInput(marker, item) {
  return { topicId: 'complete-topic', operationId: `op-${marker}`, updateId: `update-${marker}`, origin: 'reducer', files: item.files, expectedRevisions: item.expectedRevisions };
}

async function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`child did not print ${expected}: ${output}`)), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(expected)) { clearTimeout(timeout); resolve(); }
    });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`child exited before ready: ${code}/${signal}`)); });
  });
}

test('failed partial transaction blocks snapshots until recovery restores a committed view', async () => {
  const item = await fixture();
  let releaseFailure;
  const failureObserved = new Promise((resolve) => { releaseFailure = resolve; });
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot, failureInjector: async (stage, context) => {
    if (stage === 'after-file-replace' && context.index === 0) releaseFailure();
    if (stage === 'after-file-replace' && context.index === 0) return true;
  } });
  try {
    await repository.initialize();
    const input = commitInput('mixed', await proposal(repository, 'mixed'));
    const commit = repository.commit(input);
    await failureObserved;
    await assert.rejects(commit, TransactionError);
    const snapshot = await repository.snapshot('complete-topic');
    assert.equal(snapshot.state.futureTopLevelField.testMarker, 'mixed');
    assert.equal(snapshot.notes[0].body.endsWith('mixed\n'), true);
    assert.equal(snapshot.sessions.some((session) => session.id === 'session-mixed'), true);
  } finally { await repository.close().catch(() => {}); await cleanup(item); }
});

test('commits form a strict FIFO queue and close waits for the active commit', async () => {
  const item = await fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot, failureInjector: async (stage, context) => {
    if (stage === 'after-applying-marker') events.push(context.operationId);
    if (stage === 'after-applying-marker' && context.operationId === 'op-queue-a') await gate;
  } });
  try {
    await repository.initialize();
    const proposalA = await proposal(repository, 'queue-a');
    const proposalB = await proposal(repository, 'queue-b');
    const proposalC = await proposal(repository, 'queue-c');
    const a = repository.commit(commitInput('queue-a', proposalA));
    await new Promise((resolve) => setImmediate(resolve));
    const b = repository.commit(commitInput('queue-b', proposalB));
    const c = repository.commit(commitInput('queue-c', proposalC));
    const queueStarted = new Promise((resolve) => {
      const poll = () => events.includes('op-queue-a') ? resolve() : setImmediate(poll);
      poll();
    });
    await queueStarted;
    assert.deepEqual(events, ['op-queue-a']);
    const closing = repository.close();
    release();
    await Promise.allSettled([a, b, c]);
    await closing;
    const reopened = new VaultRepository(item.root, { stateRoot: item.stateRoot });
    await reopened.initialize();
    await reopened.close();
  } finally { release(); await repository.close().catch(() => {}); await cleanup(item); }
});

test('SIGKILL releases the writer lock and startup recovery can proceed', async () => {
  const item = await fixture();
  const readyPath = path.join(item.container, 'child-ready');
  const child = spawn(process.execPath, [lockHolder, item.root, item.stateRoot, readyPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const deadline = Date.now() + 5_000;
    while (!await fs.stat(readyPath).then(() => true, () => false)) {
      if (child.exitCode !== null) throw new Error(`lock holder exited before ready: ${child.exitCode}`);
      if (Date.now() > deadline) throw new Error('lock holder did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot });
    await repository.initialize();
    await repository.close();
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await cleanup(item); }
});

test('a symlink alias to the same vault cannot acquire a second writer lock', async () => {
  const item = await fixture();
  const alias = path.join(item.container, 'vault-alias');
  await fs.symlink(item.root, alias, 'dir');
  const first = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  const second = new VaultRepository(alias, { stateRoot: item.stateRoot });
  try {
    await first.initialize();
    await assert.rejects(() => second.initialize(), WriterLockError);
  } finally { await first.close().catch(() => {}); await second.close().catch(() => {}); await cleanup(item); }
});

test('commit marker recovery rebuilds the complete stable result and update replay', async () => {
  const item = await fixture();
  let injected = false;
  const first = new VaultRepository(item.root, { stateRoot: item.stateRoot, failureInjector: async (stage) => {
    if (stage === 'after-commit-marker' && !injected) { injected = true; return true; }
  } });
  const transaction = await first.initialize().then(() => proposal(first, 'marker'));
  try { await assert.rejects(() => first.commit(commitInput('marker', transaction)), TransactionError); }
  finally { await first.close(); }
  const recovered = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  try {
    await recovered.initialize();
    const replay = await recovered.commit(commitInput('marker', transaction));
    assert.equal(replay.status, 'committed');
    assert.equal(replay.saved, true);
    assert.equal(replay.replayed, true);
    assert.equal(Object.keys(replay.targetRevisions).length, 3);
    const updateReplay = await recovered.commit({ ...commitInput('marker', transaction), operationId: 'op-marker-retry' });
    assert.equal(updateReplay.status, 'duplicate');
    assert.equal(updateReplay.saved, true);
    assert.equal(Object.keys(updateReplay.targetRevisions).length, 3);
  } finally { await recovered.close(); await cleanup(item); }
});

test('every write target requires an explicit revision and null means must not exist', async () => {
  const item = await fixture();
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  try {
    await repository.initialize();
    const missing = await proposal(repository, 'missing-revision');
    delete missing.expectedRevisions[missing.snapshot.statePath];
    await assert.rejects(() => repository.commit(commitInput('missing-revision', missing)), (error) => error instanceof RepositoryError && error.code === 'invalid');

    const existing = await proposal(repository, 'null-existing');
    existing.expectedRevisions[existing.snapshot.statePath] = null;
    const conflict = await repository.commit(commitInput('null-existing', existing));
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.saved, false);
  } finally { await repository.close(); await cleanup(item); }
});

test('write targets reject symlink parent escapes', async () => {
  const item = await fixture();
  const outside = path.join(item.container, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(item.root, 'topics', 'complete-topic', 'notes', 'escape'), 'dir');
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  try {
    await repository.initialize();
    const snapshot = await repository.snapshot('complete-topic');
    const state = structuredClone(snapshot.state);
    state.notes.escaped = { id: 'escaped', path: 'topics/complete-topic/notes/escape/escaped.md', updatedAt: '2026-09-19T00:00:00.000Z' };
    await assert.rejects(() => repository.commit({ topicId: 'complete-topic', operationId: 'op-symlink', updateId: 'update-symlink', origin: 'user', files: [
      { relativePath: snapshot.statePath, content: `${JSON.stringify(state, null, 2)}\n` },
      { relativePath: state.notes.escaped.path, content: '# escaped\n' },
    ], expectedRevisions: { [snapshot.statePath]: snapshot.stateRevision, [state.notes.escaped.path]: null } }), (error) => error instanceof RepositoryError && error.code === 'invalid');
    assert.equal(await fs.stat(path.join(outside, 'escaped.md')).then(() => true, () => false), false);
  } finally { await repository.close(); await cleanup(item); }
});

test('learning no-op requires state and checkpoint and new indexes require files', async () => {
  const item = await fixture();
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  try {
    await repository.initialize();
    await assert.rejects(() => repository.commit({ topicId: 'complete-topic', operationId: 'op-empty-noop', updateId: 'update-empty-noop', origin: 'reducer', noOp: true, files: [], expectedRevisions: {} }), (error) => error instanceof RepositoryError && error.code === 'invalid');

    const snapshot = await repository.snapshot('complete-topic');
    const state = structuredClone(snapshot.state);
    state.sessions.missing = { id: 'missing', path: 'topics/complete-topic/sessions/missing.md', createdAt: '2026-09-19T00:00:00.000Z' };
    await assert.rejects(() => repository.commit({ topicId: 'complete-topic', operationId: 'op-missing-required', updateId: 'update-missing-required', origin: 'reducer', files: [{ relativePath: snapshot.statePath, content: `${JSON.stringify(state, null, 2)}\n` }], expectedRevisions: { [snapshot.statePath]: snapshot.stateRevision } }), (error) => error instanceof RepositoryError && error.code === 'invalid');
  } finally { await repository.close(); await cleanup(item); }
});

for (const fileIndex of [0, 1, 2]) {
  for (const stage of ['before-file-replace', 'after-file-replace']) {
    test(`three-file transaction recovers from ${stage} at file ${fileIndex}`, async () => {
      const item = await fixture();
      let injected = false;
      const failing = new VaultRepository(item.root, { stateRoot: item.stateRoot, failureInjector: async (candidate, context) => {
        if (candidate === stage && context.index === fileIndex && !injected) { injected = true; return true; }
      } });
      let input;
      try {
        await failing.initialize();
        input = commitInput(`${stage}-${fileIndex}`, await proposal(failing, `${stage}-${fileIndex}`));
        await assert.rejects(() => failing.commit(input), TransactionError);
      } finally { await failing.close().catch(() => {}); }
      const recovered = new VaultRepository(item.root, { stateRoot: item.stateRoot });
      try {
        await recovered.initialize();
        const snapshot = await recovered.snapshot('complete-topic');
        assert.equal(snapshot.state.futureTopLevelField.testMarker, `${stage}-${fileIndex}`);
        assert.equal(snapshot.notes[0].body.endsWith(`${stage}-${fileIndex}\n`), true);
        assert.equal(snapshot.sessions.some((session) => session.id === `session-${stage}-${fileIndex}`), true);
        const replay = await recovered.commit(input);
        assert.equal(replay.status, 'committed');
        assert.equal(replay.saved, true);
        assert.equal(Object.keys(replay.targetRevisions).length, 3);
      } finally { await recovered.close(); await cleanup(item); }
    });
  }
}
