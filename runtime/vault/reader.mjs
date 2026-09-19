import fs from 'node:fs/promises';
import path from 'node:path';
import { assertIndexedPath, assertTopicId, resolveVaultPath } from './paths.mjs';
import { blobRevision } from './revisions.mjs';

export class VaultReadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VaultReadError';
    this.code = code;
    this.details = details;
  }
}

async function readBytes(root, relativePath) {
  const absolute = resolveVaultPath(root, relativePath);
  try {
    const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new VaultReadError('schema', `vault path escapes configured root: ${relativePath}`, { relativePath });
    }
    const bytes = await fs.readFile(absolute);
    return { bytes, relativePath, revision: blobRevision(bytes) };
  } catch (error) {
    if (error instanceof VaultReadError) throw error;
    if (error.code === 'ENOENT') throw new VaultReadError('missing', `missing vault file: ${relativePath}`, { relativePath });
    throw new VaultReadError('unavailable', `unable to read vault file: ${relativePath}`, { relativePath });
  }
}

async function readJson(root, relativePath, expectedType) {
  const document = await readBytes(root, relativePath);
  try {
    document.value = JSON.parse(document.bytes.toString('utf8'));
  } catch {
    throw new VaultReadError('malformed', `malformed JSON: ${relativePath}`, { relativePath });
  }
  if (expectedType && document.value.documentType !== expectedType) {
    throw new VaultReadError('schema', `unexpected document type: ${relativePath}`, { relativePath });
  }
  return document;
}

function validateTopicBinding(topicId, state, manifest) {
  if (state.id !== topicId || state.vaultId !== manifest.vaultId) {
    throw new VaultReadError('schema', `topic binding mismatch: ${topicId}`, { topicId });
  }
}

function indexedEntries(state, key) {
  const entries = state[key];
  if (entries === undefined) return {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new VaultReadError('schema', `invalid state.${key}`);
  return entries;
}

function roadmapSummary(roadmap) {
  if (!Array.isArray(roadmap)) return null;
  const statusCounts = {};
  for (const item of roadmap) {
    const status = typeof item?.status === 'string' && item.status.trim() ? item.status.trim() : 'unclassified';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  const completedStatuses = new Set(['completed', 'complete', 'demonstrated', 'done']);
  const currentStatuses = new Set(['active', 'current', 'in-progress', 'in_progress']);
  const upcomingStatuses = new Set(['planned', 'upcoming']);
  const classify = (status) => completedStatuses.has(status) ? 'completed' : currentStatuses.has(status) ? 'current' : upcomingStatuses.has(status) ? 'upcoming' : 'other';
  const categories = { completed: 0, current: 0, upcoming: 0, other: 0 };
  for (const [status, count] of Object.entries(statusCounts)) categories[classify(status)] += count;
  return { count: roadmap.length, statusCounts, ...categories };
}

function safeIndexedPath(topicId, entry, kind) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.path !== 'string') {
    throw new VaultReadError('schema', `invalid ${kind} index entry`);
  }
  try { return assertIndexedPath(topicId, entry.path); } catch (error) {
    throw new VaultReadError('schema', `invalid ${kind} path`, { path: entry.path });
  }
}

export class VaultReader {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async readManifest() {
    return readJson(this.root, '.learning-vault/vault.json', 'vault-manifest');
  }

  async listTopics() {
    const manifest = await this.readManifest();
    if (!manifest.value.topics || typeof manifest.value.topics !== 'object') throw new VaultReadError('schema', 'manifest topics is invalid');
    const topics = [];
    for (const [topicId, binding] of Object.entries(manifest.value.topics)) {
      try {
        assertTopicId(topicId);
        if (!binding || typeof binding.statePath !== 'string') throw new Error('missing statePath');
        const state = await readJson(this.root, binding.statePath, 'topic-state');
        validateTopicBinding(topicId, state.value, manifest.value);
        topics.push({
          id: topicId,
          title: state.value.title || topicId,
          goal: state.value.goal || '',
          currentFocus: state.value.currentFocus || '',
          revision: state.revision,
          roadmapAvailable: Array.isArray(state.value.roadmap),
          roadmapSummary: roadmapSummary(state.value.roadmap),
          lastSession: Object.values(indexedEntries(state.value, 'sessions')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.createdAt || null,
        });
      } catch (error) {
        if (error instanceof VaultReadError) topics.push({ id: topicId, title: topicId, status: 'invalid', error: error.message });
        else topics.push({ id: topicId, title: topicId, status: 'invalid', error: 'invalid topic binding' });
      }
    }
    return { vaultId: manifest.value.vaultId, revision: manifest.revision, topics };
  }

  async readTopic(topicId) {
    try { assertTopicId(topicId); } catch { throw new VaultReadError('invalid', `invalid topic: ${topicId}`, { topicId }); }
    const manifest = await this.readManifest();
    const binding = manifest.value.topics?.[topicId];
    if (!binding || typeof binding.statePath !== 'string') throw new VaultReadError('invalid', `unknown topic: ${topicId}`, { topicId });
    const state = await readJson(this.root, binding.statePath, 'topic-state');
    validateTopicBinding(topicId, state.value, manifest.value);
    const topicDir = `topics/${topicId}`;
    let readme = null;
    try { readme = await readBytes(this.root, `${topicDir}/README.md`); } catch (error) { if (error.code !== 'missing') throw error; }

    const notes = [];
    for (const [id, index] of Object.entries(indexedEntries(state.value, 'notes'))) {
      if (index.id !== id) throw new VaultReadError('schema', `note identity mismatch: ${id}`);
      const relativePath = safeIndexedPath(topicId, index, 'note');
      const body = await readBytes(this.root, relativePath);
      notes.push({ id, index: structuredClone(index), revision: body.revision, body: body.bytes.toString('utf8') });
    }
    const sessions = [];
    for (const [id, index] of Object.entries(indexedEntries(state.value, 'sessions'))) {
      if (index.id !== id) throw new VaultReadError('schema', `session identity mismatch: ${id}`);
      const relativePath = safeIndexedPath(topicId, index, 'session');
      const body = await readBytes(this.root, relativePath);
      sessions.push({ id, index: structuredClone(index), revision: body.revision, body: body.bytes.toString('utf8') });
    }
    return {
      id: topicId,
      state: structuredClone(state.value),
      stateRevision: state.revision,
      readme: readme ? { revision: readme.revision, body: readme.bytes.toString('utf8') } : null,
      notes,
      sessions,
      manifestRevision: manifest.revision,
    };
  }
}
