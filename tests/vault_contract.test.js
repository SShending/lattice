const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, 'fixtures', 'vault');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));
const blobRevision = (bytes) => {
  const data = Buffer.from(bytes);
  return crypto.createHash('sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex');
};

test('manifest bindings and topic identities are lossless', () => {
  const manifest = json('manifest.json');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.topics['complete-topic'].futureBinding, 'keep');
  for (const [topicId, binding] of Object.entries(manifest.topics)) {
    const state = json(binding.statePath);
    assert.equal(state.id, topicId);
    assert.equal(state.vaultId, manifest.vaultId);
  }
});

test('JSON round-trip retains unknown top-level and nested fields', () => {
  const source = json('topics/complete-topic/state.json');
  const serialized = JSON.stringify(JSON.parse(JSON.stringify(source)));
  const roundTripped = JSON.parse(serialized);
  assert.deepEqual(roundTripped.futureTopLevelField, source.futureTopLevelField);
  assert.deepEqual(roundTripped.concepts['lossless-mapping'].futureConceptField,
    source.concepts['lossless-mapping'].futureConceptField);
  assert.equal(roundTripped.notes['synthetic-note'].futureNoteIndexField, 'keep');
  assert.equal(roundTripped.sessions['session-2026-09-18-complete-topic-001'].futureSessionIndexField, false);
  assert.equal(roundTripped.appliedUpdates['fixture-update-001'].futureUpdateField, 'keep');
  assert.equal(blobRevision(read('topics/complete-topic/state.json')).length, 40);
});

test('Markdown note and checkpoint bodies remain opaque and byte-stable', () => {
  const note = read('topics/complete-topic/notes/synthetic-note.md');
  const session = read('topics/complete-topic/sessions/session-2026-09-18-complete-topic-001.md');
  assert.equal(note, read('topics/complete-topic/notes/synthetic-note.md'));
  assert.match(session, /Update ID: `fixture-update-001`/);
  assert.match(session, /Base state revision: `fixture-base-revision`/);
});

test('missing optional roadmap is represented as absent, not inferred', () => {
  const state = json('topics/legacy-topic/state.json');
  assert.equal(Object.hasOwn(state, 'roadmap'), false);
  assert.deepEqual(state.notes, {});
  assert.deepEqual(state.sessions, {});
});
