import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultRepository, RepositoryError, TransactionError, TransactionConflictError, WriterLockError } from '../runtime/vault/repository.mjs';
import { VaultReader } from '../runtime/vault/reader.mjs';
import { blobRevision } from '../runtime/vault/revisions.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtureRoot = path.join(here, 'fixtures', 'vault');

async function makeVault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-persistence-'));
  await fs.cp(fixtureRoot, root, { recursive: true });
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-state-'));
  return { root, stateRoot };
}

async function removeTree(root) { await fs.rm(root, { recursive: true, force: true }); }

async function withRepository(fn, options = {}) {
  const fixture = await makeVault();
  const repository = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot, ...options });
  try { await repository.initialize(); return await fn({ ...fixture, repository }); }
  finally { await repository.close().catch(() => {}); await removeTree(fixture.root); await removeTree(fixture.stateRoot); }
}

async function stateAndNote(repository, root, marker = 'changed') {
  const snapshot = await repository.snapshot('complete-topic');
  const state = structuredClone(snapshot.state);
  state.futureTopLevelField.testMarker = marker;
  const note = snapshot.notes[0];
  return {
    snapshot,
    state,
    files: [
      { relativePath: snapshot.statePath, content: `${JSON.stringify(state, null, 2)}\n` },
      { relativePath: note.index.path, content: `${note.body}\n\n${marker}` },
    ],
    expectedRevisions: { [snapshot.statePath]: snapshot.stateRevision, [note.index.path]: note.revision },
  };
}

test('normal state + note + checkpoint transaction is durable and idempotent', async () => {
  await withRepository(async ({ repository }) => {
    const proposal = await stateAndNote(repository, null, 'normal');
    const sessionId = 'session-lattice-normal-001';
    proposal.state.sessions[sessionId] = { id: sessionId, path: `topics/complete-topic/sessions/${sessionId}.md`, createdAt: '2026-09-19T00:00:00.000Z' };
    proposal.files[0].content = `${JSON.stringify(proposal.state, null, 2)}\n`;
    proposal.files.push({ relativePath: proposal.state.sessions[sessionId].path, content: '# Normal checkpoint\n\nUpdate ID: `update-normal`\n' });
    proposal.expectedRevisions[proposal.state.sessions[sessionId].path] = null;
    const result = await repository.commit({ topicId: 'complete-topic', operationId: 'op-normal', updateId: 'update-normal', origin: 'reducer', files: proposal.files, expectedRevisions: proposal.expectedRevisions, metadata: { checkpoint: sessionId } });
    assert.equal(result.status, 'committed');
    assert.equal(result.saved, true);
    const replay = await repository.commit({ topicId: 'complete-topic', operationId: 'op-normal', updateId: 'update-normal', origin: 'reducer', files: proposal.files, expectedRevisions: proposal.expectedRevisions });
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 'committed');
    const after = await repository.snapshot('complete-topic');
    assert.equal(after.state.futureTopLevelField.testMarker, 'normal');
    assert.equal(after.notes[0].body.endsWith('normal'), true);
    assert.equal(after.sessions.some((session) => session.id === sessionId), true);
  });
});

test('stale revision and external modification are conflicts without false save', async () => {
  await withRepository(async ({ repository, root }) => {
    const proposal = await stateAndNote(repository, null, 'stale');
    const stale = await repository.commit({ topicId: 'complete-topic', operationId: 'op-stale', updateId: 'update-stale', origin: 'user', files: proposal.files, expectedRevisions: { ...proposal.expectedRevisions, [proposal.snapshot.statePath]: '0'.repeat(40) } });
    assert.equal(stale.status, 'conflict');
    assert.equal(stale.saved, false);

    const external = await repository.snapshot('complete-topic');
    const statePath = path.join(root, external.statePath);
    const original = await fs.readFile(statePath);
    const proposal2 = await stateAndNote(repository, null, 'external');
    const conflictedRepository = repository;
    conflictedRepository.failureInjector = async (stage) => {
      if (stage === 'before-file-replace') await fs.writeFile(statePath, Buffer.concat([original, Buffer.from(' ')]));
    };
    const conflict = await repository.commit({ topicId: 'complete-topic', operationId: 'op-external', updateId: 'update-external', origin: 'user', files: proposal2.files, expectedRevisions: proposal2.expectedRevisions });
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.saved, false);
    assert.equal((await fs.readFile(statePath)).toString().endsWith(' '), true);
  });
});

test('one writer lock rejects a second Lattice repository', async () => {
  const fixture = await makeVault();
  const first = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot });
  const second = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot });
  try {
    await first.initialize();
    await assert.rejects(() => second.initialize(), (error) => error instanceof WriterLockError && error.code === 'writer-locked');
  } finally {
    await first.close().catch(() => {}); await second.close().catch(() => {});
    await removeTree(fixture.root); await removeTree(fixture.stateRoot);
  }
});

const recoveryStages = [
  'after-manifest-prepared', 'after-operation-pending', 'after-applying-marker',
  'after-file-replace', 'before-commit-marker', 'after-commit-marker', 'before-operation-record',
];

for (const stage of recoveryStages) {
  test(`restart recovery after ${stage}`, async () => {
    const fixture = await makeVault();
    let calls = 0;
    const failing = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot, failureInjector: async (candidate) => {
      if (candidate === stage && calls++ === 0) return true;
    } });
    try {
      await failing.initialize();
      const proposal = await stateAndNote(failing, null, `recovery-${stage}`);
      const sessionId = `session-recovery-${stage.replaceAll(':', '-')}`;
      proposal.state.sessions[sessionId] = { id: sessionId, path: `topics/complete-topic/sessions/${sessionId}.md`, createdAt: '2026-09-19T00:00:00.000Z' };
      proposal.files[0].content = `${JSON.stringify(proposal.state, null, 2)}\n`;
      proposal.files.push({ relativePath: proposal.state.sessions[sessionId].path, content: `# recovery-${stage}\n` });
      proposal.expectedRevisions[proposal.state.sessions[sessionId].path] = null;
      await assert.rejects(() => failing.commit({ topicId: 'complete-topic', operationId: `op-${stage.replaceAll(':', '-')}`, updateId: `update-${stage.replaceAll(':', '-')}`, origin: 'reducer', files: proposal.files, expectedRevisions: proposal.expectedRevisions }), (error) => error instanceof TransactionError || error.code === 'injected-failure');
      failing._proposal = proposal;
    } finally { await failing.close().catch(() => {}); }
    const recovered = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot });
    try {
      await recovered.initialize();
      const snapshot = await recovered.snapshot('complete-topic');
      assert.equal(snapshot.state.futureTopLevelField.testMarker, `recovery-${stage}`);
    } finally { await recovered.close().catch(() => {}); await removeTree(fixture.root); await removeTree(fixture.stateRoot); }
  });
}

for (const stage of ['before-stage-write', 'after-stage-write', 'before-manifest-prepared']) {
  test(`failure during ${stage} leaves a pending journal and canonical files unchanged`, async () => {
    const fixture = await makeVault();
    const failing = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot, failureInjector: async (candidate) => candidate === stage });
    try {
      await failing.initialize();
      const proposal = await stateAndNote(failing, null, `staging-${stage}`);
      await assert.rejects(() => failing.commit({ topicId: 'complete-topic', operationId: `op-${stage}`, updateId: `update-${stage}`, origin: 'user', files: proposal.files, expectedRevisions: proposal.expectedRevisions }), (error) => error.code === 'injected-failure');
    } finally { await failing.close().catch(() => {}); }
    const recovered = new VaultRepository(fixture.root, { stateRoot: fixture.stateRoot });
    try {
      await recovered.initialize();
      assert.equal((await recovered.snapshot('complete-topic')).state.futureTopLevelField.testMarker, undefined);
      const outcomes = await recovered.recover();
      assert.equal(outcomes[0].status, 'abandoned');
    } finally { await recovered.close().catch(() => {}); await removeTree(fixture.root); await removeTree(fixture.stateRoot); }
  });
}

test('validated no-op checkpoint has a durable operation outcome', async () => {
  await withRepository(async ({ repository }) => {
    const snapshot = await repository.snapshot('complete-topic');
    const state = structuredClone(snapshot.state);
    const sessionId = 'session-lattice-noop-001';
    state.sessions[sessionId] = { id: sessionId, path: `topics/complete-topic/sessions/${sessionId}.md`, createdAt: '2026-09-19T00:00:00.000Z' };
    const result = await repository.commit({ topicId: 'complete-topic', operationId: 'op-noop', updateId: 'update-noop', origin: 'reducer', noOp: true, files: [
      { relativePath: snapshot.statePath, content: JSON.stringify(state, null, 2) + '\n' },
      { relativePath: state.sessions[sessionId].path, content: '# No-op checkpoint\n' },
    ], expectedRevisions: { [snapshot.statePath]: snapshot.stateRevision, [state.sessions[sessionId].path]: null } });
    assert.equal(result.status, 'committed');
    assert.equal(result.noOp, true);
  });
});

test('invalid transaction never reports saved or mutates canonical files', async () => {
  await withRepository(async ({ repository }) => {
    const snapshot = await repository.snapshot('complete-topic');
    await assert.rejects(() => repository.commit({ topicId: 'complete-topic', operationId: 'op-invalid', updateId: 'update-invalid', origin: 'user', files: [{ relativePath: snapshot.statePath, content: '{bad' }], expectedRevisions: { [snapshot.statePath]: snapshot.stateRevision } }), RepositoryError);
    assert.equal((await repository.snapshot('complete-topic')).state.futureTopLevelField.must, 'survive');
  });
});
