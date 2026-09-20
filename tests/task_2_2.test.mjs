import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VaultRepository, RepositoryError } from '../runtime/vault/repository.mjs';
import { createServer } from '../server/main.mjs';
import { blobRevision } from '../runtime/vault/revisions.mjs';
import { createNoteDraftState, reconcileNoteDraftState } from '../web/note-drafts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'vault');

async function fixture() {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-task-2-2-'));
  const root = path.join(container, 'vault');
  const stateRoot = path.join(container, 'state');
  await fs.cp(fixtureRoot, root, { recursive: true });
  await fs.mkdir(stateRoot);
  return { container, root, stateRoot };
}

async function cleanup(item) { await fs.rm(item.container, { recursive: true, force: true }); }

async function request(server, method, pathname, body, headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function openRepository(item) {
  const repository = new VaultRepository(item.root, { stateRoot: item.stateRoot });
  await repository.initialize();
  return repository;
}

test('user note edit commits losslessly, survives restart, and records provenance', async () => {
  const item = await fixture();
  const repository = await openRepository(item);
  try {
    const before = await repository.snapshot('complete-topic');
    const note = before.notes.find((entry) => entry.id === 'synthetic-note');
    const result = await repository.saveNote({
      topicId: 'complete-topic', noteId: note.id, body: '# Edited note\n\nUser-authored body.\n',
      title: 'Edited note', kind: 'learning_note', claimStatus: 'working_model', sources: [],
      expectedRevision: note.revision, expectedStateRevision: before.stateRevision,
      operationId: 'op-user-note-edit', updateId: 'update-user-note-edit',
    });
    assert.equal(result.status, 'committed');
    assert.equal(result.saved, true);
    assert.equal(result.origin, 'user');
    assert.equal(result.metadata.provenance.origin, 'user');
    assert.equal(result.metadata.provenance.noteId, note.id);
    const after = await repository.snapshot('complete-topic');
    assert.equal(after.notes[0].body, '# Edited note\n\nUser-authored body.\n');
    assert.equal(after.notes[0].index.title, 'Edited note');
    assert.equal(after.notes[0].index.futureNoteIndexField, 'keep');
    assert.equal(after.state.futureTopLevelField.must, 'survive');
    const replay = await repository.saveNote({
      topicId: 'complete-topic', noteId: note.id, body: '# Edited note\n\nUser-authored body.\n',
      title: 'Edited note', expectedRevision: note.revision, expectedStateRevision: before.stateRevision,
      operationId: 'op-user-note-edit', updateId: 'update-user-note-edit',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.saved, true);
  } finally { await repository.close(); }
  const reopened = await openRepository(item);
  try {
    const snapshot = await reopened.snapshot('complete-topic');
    assert.equal(snapshot.notes[0].body, '# Edited note\n\nUser-authored body.\n');
    const replay = await reopened.saveNote({
      topicId: 'complete-topic', noteId: 'synthetic-note', body: '# Edited note\n\nUser-authored body.\n',
      title: 'Edited note', expectedRevision: snapshot.notes[0].revision, expectedStateRevision: snapshot.stateRevision,
      operationId: 'op-user-note-edit', updateId: 'update-user-note-edit',
    });
    assert.equal(replay.replayed, true);
  } finally { await reopened.close(); await cleanup(item); }
});

test('new user notes require explicit revisions and preserve complete state fields', async () => {
  const item = await fixture();
  const repository = await openRepository(item);
  try {
    const before = await repository.snapshot('legacy-topic');
    const result = await repository.saveNote({
      topicId: 'legacy-topic', noteId: 'user-created', body: '# Created\n\nA new local note.\n',
      title: 'Created', expectedRevision: null, expectedStateRevision: before.stateRevision,
      operationId: 'op-user-note-create', updateId: 'update-user-note-create',
    });
    assert.equal(result.saved, true);
    assert.equal(result.provenance.action, 'create');
    const after = await repository.snapshot('legacy-topic');
    assert.equal(after.notes[0].id, 'user-created');
    assert.equal(after.notes[0].index.path, 'topics/legacy-topic/notes/user-created.md');
    assert.equal(after.state.legacyExtension.keep, true);
  } finally { await repository.close(); await cleanup(item); }
});

test('invalid note fields are rejected without a save', async () => {
  const item = await fixture();
  const repository = await openRepository(item);
  try {
    const before = await repository.snapshot('complete-topic');
    const note = before.notes[0];
    for (const invalid of [
      { noteId: '../escape' },
      { noteId: note.id, body: 3 },
      { noteId: note.id, body: 'ok', title: 'x'.repeat(241) },
      { noteId: note.id, body: 'ok', sources: 'not-an-array' },
      { noteId: note.id, body: 'ok', sources: Array.from({ length: 101 }, () => 'source') },
      { noteId: note.id, body: 'ok', expectedRevision: 'bad' },
      { noteId: note.id, body: 'ok', expectedStateRevision: 'bad' },
      { noteId: note.id, body: 'ok', unsupported: true },
    ]) {
      await assert.rejects(() => repository.saveNote({ topicId: 'complete-topic', operationId: `op-invalid-${Math.random().toString(16).slice(2)}`, updateId: `update-invalid-${Math.random().toString(16).slice(2)}`, expectedRevision: note.revision, expectedStateRevision: before.stateRevision, ...invalid }), (error) => error instanceof RepositoryError && error.code === 'invalid');
    }
    const after = await repository.snapshot('complete-topic');
    assert.equal(after.notes[0].body, note.body);
    assert.equal(after.stateRevision, before.stateRevision);
  } finally { await repository.close(); await cleanup(item); }
});

test('stale note and state revisions return conflict without overwriting newer content', async () => {
  const item = await fixture();
  const repository = await openRepository(item);
  try {
    const before = await repository.snapshot('complete-topic');
    const note = before.notes[0];
    await fs.writeFile(path.join(item.root, note.index.path), '# External edit\n');
    const result = await repository.saveNote({
      topicId: 'complete-topic', noteId: note.id, body: '# Stale local draft\n',
      expectedRevision: note.revision, expectedStateRevision: before.stateRevision,
      operationId: 'op-stale-note', updateId: 'update-stale-note',
    });
    assert.equal(result.status, 'conflict');
    assert.equal(result.saved, false);
    assert.equal(await fs.readFile(path.join(item.root, note.index.path), 'utf8'), '# External edit\n');
  } finally { await repository.close(); await cleanup(item); }
});

test('stale state revision conflicts even when the note body is unchanged externally', async () => {
  const item = await fixture();
  const repository = await openRepository(item);
  try {
    const before = await repository.snapshot('complete-topic');
    const statePath = path.join(item.root, before.statePath);
    const originalState = await fs.readFile(statePath, 'utf8');
    await fs.writeFile(statePath, `${originalState}\n`);
    const result = await repository.saveNote({
      topicId: 'complete-topic', noteId: before.notes[0].id, body: '# Local draft\n',
      expectedRevision: before.notes[0].revision, expectedStateRevision: before.stateRevision,
      operationId: 'op-stale-state', updateId: 'update-stale-state',
    });
    assert.equal(result.status, 'conflict');
    assert.equal(result.saved, false);
    assert.equal(await fs.readFile(path.join(item.root, before.notes[0].index.path), 'utf8'), before.notes[0].body);
  } finally { await repository.close(); await cleanup(item); }
});

test('incoming updates refresh a clean editor but preserve an open dirty draft as conflict', () => {
  const topic = { id: 'complete-topic', source: { stateRevision: 'a'.repeat(40) } };
  const original = { id: 'synthetic-note', body: '# Original\n', revision: 'b'.repeat(40), index: { title: 'Original', future: 'keep' } };
  const incomingTopic = { ...topic, source: { stateRevision: 'c'.repeat(40) } };
  const incoming = { ...original, body: '# Incoming\n', revision: 'd'.repeat(40), index: { ...original.index, title: 'Incoming' } };

  const clean = createNoteDraftState(topic, original, original.id);
  reconcileNoteDraftState(clean, incomingTopic, incoming);
  assert.equal(clean.body, '# Incoming\n');
  assert.equal(clean.expectedRevision, incoming.revision);

  const dirty = createNoteDraftState(topic, original, original.id);
  dirty.body = '# Unsaved local draft\n';
  dirty.dirty = true;
  dirty.status = 'draft';
  reconcileNoteDraftState(dirty, incomingTopic, incoming);
  assert.equal(dirty.body, '# Unsaved local draft\n');
  assert.equal(dirty.status, 'conflict');
  assert.equal(dirty.latest.body, '# Incoming\n');
  assert.equal(dirty.expectedRevision, original.revision);
});

test('HTTP note editor saves only notes, exposes conflicts, and has no Understanding write route', async () => {
  const item = await fixture();
  const server = createServer({ vaultRoot: item.root, port: 0, repositoryOptions: { stateRoot: item.stateRoot } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const initial = await request(server, 'GET', '/api/topics/complete-topic');
    const topic = initial.json();
    const note = topic.notes[0];
    const health = await request(server, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json().notes, 'available');
    assert.equal(health.json().understanding, 'read-only');
    const browserModule = await request(server, 'GET', '/note-drafts.mjs');
    assert.equal(browserModule.status, 200);
    assert.match(browserModule.headers['content-type'], /^text\/javascript/);
    const saved = await request(server, 'PUT', '/api/topics/complete-topic/notes/synthetic-note', {
      body: '# HTTP edit\n\nSaved over HTTP.\n', title: 'HTTP edit', expectedRevision: note.revision,
      expectedStateRevision: topic.source.stateRevision, operationId: 'op-http-note', updateId: 'update-http-note',
    }, { origin: `http://127.0.0.1:${server.address().port}` });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().saved, true);
    assert.equal(saved.json().origin, 'user');
    const loaded = await request(server, 'GET', '/api/topics/complete-topic');
    assert.equal(loaded.json().notes[0].preview, 'Saved over HTTP.');
    const stateWrite = await request(server, 'PUT', '/api/topics/complete-topic/state', { state: {} }, { origin: `http://127.0.0.1:${server.address().port}` });
    assert.equal(stateWrite.status, 405);
    const understandingWrite = await request(server, 'PUT', '/api/topics/complete-topic/understanding', { misconceptions: [] }, { origin: `http://127.0.0.1:${server.address().port}` });
    assert.equal(understandingWrite.status, 405);
    const crossOrigin = await request(server, 'PUT', '/api/topics/complete-topic/notes/synthetic-note', { body: 'x', expectedRevision: loaded.json().notes[0].revision, expectedStateRevision: loaded.json().source.stateRevision, operationId: 'op-cross-note', updateId: 'update-cross-note' }, { origin: 'https://evil.example' });
    assert.equal(crossOrigin.status, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); await cleanup(item); }
});

test('browser contract keeps note drafts/edit controls and Understanding mutation-free', async () => {
  const index = await fs.readFile(path.join(here, '..', 'web', 'index.html'), 'utf8');
  const app = await fs.readFile(path.join(here, '..', 'web', 'app.js'), 'utf8');
  assert.match(index, /Notes editable - Understanding read-only/);
  assert.match(app, /noteDrafts/);
  assert.match(app, /data-note-form/);
  assert.match(app, /data-save-note/);
  assert.match(app, /expectedStateRevision/);
  assert.match(app, /status === 'conflict'/);
  assert.match(app, /data-refresh-notes/);
  assert.match(app, /data-reload-latest/);
  assert.match(app, /setInterval\(\(\) => \{ refreshNotes/);
  assert.match(app, /beforeunload/);
  const drafts = await fs.readFile(path.join(here, '..', 'web', 'note-drafts.mjs'), 'utf8');
  assert.match(drafts, /status: note \? 'saved' : 'draft'/);
  assert.doesNotMatch(app, /origin\s*:\s*['"]user['"]/);
  assert.doesNotMatch(app, /understanding.*PUT/i);
  assert.doesNotMatch(app, /state\.json.*textarea/i);
});
