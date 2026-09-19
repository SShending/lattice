import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { assertIndexedPath, assertTopicId, resolveVaultPath } from './paths.mjs';
import { VaultReader } from './reader.mjs';
import { blobRevision } from './revisions.mjs';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FAILURE = Symbol('failure injection');

export class RepositoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.details = details;
  }
}

export class WriterLockError extends RepositoryError {
  constructor(message, details = {}) { super('writer-locked', message, details); }
}

export class TransactionConflictError extends RepositoryError {
  constructor(message, details = {}) { super('conflict', message, details); }
}

export class TransactionError extends RepositoryError {
  constructor(message, details = {}) { super('transaction-failed', message, details); }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function now() { return new Date().toISOString(); }

function homeStateRoot() {
  return process.env.XDG_STATE_HOME
    ? path.join(process.env.XDG_STATE_HOME, 'lattice')
    : path.join(os.homedir(), '.local', 'state', 'lattice');
}

export function operationalRoot(vaultRoot, stateRoot = homeStateRoot()) {
  const normalized = path.resolve(vaultRoot);
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  return path.join(stateRoot, 'vaults', digest);
}

function assertOperationId(id, name) {
  if (typeof id !== 'string' || !OPERATION_ID.test(id)) throw new RepositoryError('invalid', `${name} is invalid`);
  return id;
}

async function mkdirp(directory) { await fs.mkdir(directory, { recursive: true }); }

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error; }
  finally { await handle?.close().catch(() => {}); }
}

async function writeDurable(filename, bytes) {
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, filename);
  await syncDirectory(path.dirname(filename));
}

async function readOptional(filename) {
  try { return await fs.readFile(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readJsonFile(filename) {
  const bytes = await readOptional(filename);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new RepositoryError('metadata-corrupt', `malformed operational metadata: ${filename}`); }
}

function relativeFingerprint(bytes) { return bytes === null ? null : blobRevision(bytes); }

function fileEntry(relativePath, content) {
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content);
  return { relativePath, bytes, targetRevision: blobRevision(bytes) };
}

function failureName(stage, index) { return index === undefined ? stage : `${stage}:${index}`; }

export class VaultRepository {
  constructor(vaultRoot, options = {}) {
    if (!vaultRoot) throw new RepositoryError('invalid', 'vaultRoot is required');
    this.root = path.resolve(vaultRoot);
    this.reader = options.reader || new VaultReader(this.root);
    this.stateRoot = options.stateRoot || homeStateRoot();
    this.metadataRoot = options.metadataRoot || operationalRoot(this.root, this.stateRoot);
    this.transactionsRoot = path.join(this.metadataRoot, 'transactions');
    this.operationsRoot = path.join(this.metadataRoot, 'operations');
    this.diagnosticsRoot = path.join(this.metadataRoot, 'diagnostics');
    this.lockPath = path.join(this.metadataRoot, 'writer.lock');
    this.failureInjector = options.failureInjector || null;
    this.lockHandle = null;
    this.lockToken = null;
    this.ready = false;
    this.committing = null;
  }

  async initialize() {
    if (this.ready) return this;
    await mkdirp(this.transactionsRoot);
    await mkdirp(this.operationsRoot);
    await mkdirp(this.diagnosticsRoot);
    await this.acquireWriterLock();
    try { await this.recover(); }
    catch (error) {
      await this.releaseWriterLock();
      throw error;
    }
    this.ready = true;
    return this;
  }

  async close() {
    await this.releaseWriterLock();
    this.ready = false;
  }

  async acquireWriterLock() {
    if (this.lockHandle) return;
    await mkdirp(this.metadataRoot);
    try {
      this.lockHandle = await fs.open(this.lockPath, 'wx', 0o600);
      this.lockToken = crypto.randomUUID();
      await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: now(), token: this.lockToken }));
      await this.lockHandle.sync();
    } catch (error) {
      await this.lockHandle?.close().catch(() => {});
      this.lockHandle = null;
      if (error.code === 'EEXIST') throw new WriterLockError('another Lattice writer owns this vault', { lockPath: this.lockPath });
      throw error;
    }
  }

  async releaseWriterLock() {
    if (!this.lockHandle) return;
    const handle = this.lockHandle;
    this.lockHandle = null;
    await handle.close().catch(() => {});
    const lock = await readJsonFile(this.lockPath).catch(() => null);
    if (!lock || lock.token === this.lockToken) await fs.unlink(this.lockPath).catch(() => {});
    this.lockToken = null;
    await syncDirectory(this.metadataRoot).catch(() => {});
  }

  async ensureReady() {
    if (!this.ready) await this.initialize();
  }

  async snapshot(topicId) {
    await this.ensureReady();
    if (this.committing) await this.committing.catch(() => {});
    return this.#snapshot(topicId);
  }

  async #snapshot(topicId) {
    assertTopicId(topicId);
    const topic = await this.reader.readTopic(topicId);
    const manifest = await this.reader.readManifest();
    const statePath = manifest.value.topics?.[topicId]?.statePath;
    if (typeof statePath !== 'string') throw new RepositoryError('schema', `missing state path for ${topicId}`);
    const files = { [statePath]: topic.stateRevision };
    if (topic.readme) files[`topics/${topicId}/README.md`] = topic.readme.revision;
    for (const note of topic.notes) files[note.index.path] = note.revision;
    for (const session of topic.sessions) files[session.index.path] = session.revision;
    return { ...topic, statePath, fileRevisions: files };
  }

  async commit(input) {
    await this.ensureReady();
    if (this.committing) await this.committing.catch(() => {});
    const run = this.#commit(input);
    this.committing = run;
    try { return await run; }
    finally { if (this.committing === run) this.committing = null; }
  }

  async #commit(input) {
    const request = this.#validateRequest(input);
    const operationPath = path.join(this.operationsRoot, `${request.operationId}.json`);
    const existing = await readJsonFile(operationPath);
    if (existing) return this.#replayOrRecover(existing, request);
    const duplicate = await this.#findUpdate(request.updateId);
    if (duplicate) return { ...duplicate, status: 'duplicate', replayed: true };

    const transactionPath = path.join(this.transactionsRoot, request.operationId);
    await mkdirp(transactionPath);
    const stagingJournal = {
      version: 1,
      operationId: request.operationId,
      updateId: request.updateId,
      topicId: request.topicId,
      origin: request.origin,
      createdAt: now(),
      status: 'staging',
      noOp: request.noOp,
      expectedRevisions: request.expectedRevisions,
      files: [],
      metadata: request.metadata,
      operation: { operationId: request.operationId, updateId: request.updateId, topicId: request.topicId, origin: request.origin, status: 'pending', saved: false },
    };
    await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(stagingJournal));
    const transaction = await this.#prepare(request);
    await this.#inject('before-manifest-prepared', request, transaction);
    await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(transaction.manifest));
    await this.#inject('after-manifest-prepared', request, transaction);
    await writeDurable(operationPath, jsonBytes(transaction.operation));
    await this.#inject('after-operation-pending', request, transaction);
    return this.#apply(transaction);
  }

  async recover() {
    await mkdirp(this.transactionsRoot);
    const entries = await fs.readdir(this.transactionsRoot, { withFileTypes: true });
    const outcomes = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !OPERATION_ID.test(entry.name)) continue;
      const transactionPath = path.join(this.transactionsRoot, entry.name);
      const manifest = await readJsonFile(path.join(transactionPath, 'manifest.json'));
      if (!manifest || ['committed', 'conflict'].includes(manifest.status)) continue;
      try {
        outcomes.push(await this.#recoverTransaction(transactionPath, manifest));
      } catch (error) {
        if (error instanceof TransactionConflictError) outcomes.push({ status: 'conflict', operationId: manifest.operationId, error: error.message });
        else throw error;
      }
    }
    return outcomes;
  }

  async #recoverTransaction(transactionPath, manifest) {
    const operationPath = path.join(this.operationsRoot, `${manifest.operationId}.json`);
    if (manifest.status === 'staging') return { status: 'pending', saved: false, operationId: manifest.operationId, recoverable: true, replayed: true };
    const commitPath = path.join(transactionPath, 'commit.json');
    if (await readOptional(commitPath)) {
      const committed = { ...manifest, status: 'committed', committedAt: manifest.committedAt || now() };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(committed));
      await writeDurable(operationPath, jsonBytes({ ...manifest.operation, status: 'committed', saved: true, committedAt: committed.committedAt }));
      return { status: 'committed', operationId: manifest.operationId, replayed: true };
    }
    const operation = await readJsonFile(operationPath) || manifest.operation;
    if (!operation) throw new RepositoryError('metadata-corrupt', `missing operation record: ${manifest.operationId}`);
    return this.#apply({ transactionPath, manifest, operation, request: this.#requestFromManifest(manifest) });
  }

  #requestFromManifest(manifest) {
    return {
      operationId: manifest.operationId,
      updateId: manifest.updateId,
      topicId: manifest.topicId,
      origin: manifest.origin,
      noOp: manifest.noOp,
      metadata: manifest.metadata || {},
      expectedRevisions: manifest.expectedRevisions || {},
      files: [],
    };
  }

  async #replayOrRecover(existing, request) {
    if (existing.status === 'pending') {
      const transactionPath = path.join(this.transactionsRoot, request.operationId);
      const manifest = await readJsonFile(path.join(transactionPath, 'manifest.json'));
      if (manifest?.status === 'staging') {
        const transaction = await this.#prepare(request);
        await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(transaction.manifest));
        return this.#apply({ ...transaction, operation: existing });
      }
      if (manifest) return this.#apply({ transactionPath, manifest, operation: existing, request: this.#requestFromManifest(manifest) });
    }
    return { ...existing.result, replayed: true };
  }

  async #prepare(request) {
    const snapshot = await this.#snapshot(request.topicId);
    const stateEntry = request.files.find((entry) => entry.relativePath === snapshot.statePath);
    if (stateEntry) this.#validateStateAfterImage(stateEntry.bytes, request.topicId, snapshot.state?.vaultId);
    this.#validateLogicalFiles(request, snapshot, stateEntry);
    const entries = [];
    const transactionPath = path.join(this.transactionsRoot, request.operationId);
    for (const [index, entry] of request.files.entries()) {
      const absolute = this.#secureTarget(request.topicId, entry.relativePath);
      const before = await readOptional(absolute);
      const expected = request.expectedRevisions[entry.relativePath] ?? null;
      entries.push({
        index,
        relativePath: entry.relativePath,
        stagePath: `staged/${String(index).padStart(3, '0')}.bin`,
        originalPath: `original/${String(index).padStart(3, '0')}.bin`,
        baseRevision: expected ?? relativeFingerprint(before),
        observedRevision: relativeFingerprint(before),
        targetRevision: entry.targetRevision,
        targetExists: true,
      });
      await mkdirp(path.join(transactionPath, 'staged'));
      await mkdirp(path.join(transactionPath, 'original'));
      await this.#inject('before-stage-write', request, { index, relativePath: entry.relativePath });
      await writeDurable(path.join(transactionPath, entries.at(-1).stagePath), entry.bytes);
      if (before) await writeDurable(path.join(transactionPath, entries.at(-1).originalPath), before);
      else await writeDurable(path.join(transactionPath, entries.at(-1).originalPath), Buffer.alloc(0));
      await this.#inject('after-stage-write', request, { index, relativePath: entry.relativePath });
    }
    const manifest = {
      version: 1,
      operationId: request.operationId,
      updateId: request.updateId,
      topicId: request.topicId,
      origin: request.origin,
      createdAt: now(),
      status: 'prepared',
      noOp: request.noOp,
      expectedRevisions: request.expectedRevisions,
      files: entries,
      metadata: request.metadata,
    };
    const operation = {
      version: 1,
      operationId: request.operationId,
      updateId: request.updateId,
      topicId: request.topicId,
      origin: request.origin,
      status: 'pending',
      saved: false,
      createdAt: manifest.createdAt,
    };
    manifest.operation = operation;
    return { transactionPath, manifest, operation, request };
  }

  async #apply(transaction) {
    const { transactionPath, request } = transaction;
    let manifest = transaction.manifest;
    const operationPath = path.join(this.operationsRoot, `${manifest.operationId}.json`);
    try {
      await this.#checkExpected(manifest, request);
      manifest = { ...manifest, status: 'applying', applyingAt: now() };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
      await this.#inject('after-applying-marker', request, manifest);
      for (const file of manifest.files) {
        const target = this.#secureTarget(manifest.topicId, file.relativePath);
        const current = await readOptional(target);
        const currentRevision = relativeFingerprint(current);
        if (currentRevision === file.targetRevision) {
          file.applied = true;
          continue;
        }
        if (currentRevision !== file.baseRevision) throw new TransactionConflictError(`external modification detected: ${file.relativePath}`, { relativePath: file.relativePath, expected: file.baseRevision, actual: currentRevision, operationId: manifest.operationId });
        await this.#inject('before-file-replace', request, file);
        const checked = await readOptional(target);
        const checkedRevision = relativeFingerprint(checked);
        if (checkedRevision !== file.baseRevision) throw new TransactionConflictError(`external modification detected: ${file.relativePath}`, { relativePath: file.relativePath, expected: file.baseRevision, actual: checkedRevision, operationId: manifest.operationId });
        const stage = await fs.readFile(path.join(transactionPath, file.stagePath));
        await this.#atomicReplace(target, stage, manifest.operationId, file.index);
        file.applied = true;
        await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
        await this.#inject('after-file-replace', request, file);
      }
      for (const file of manifest.files) {
        const target = this.#secureTarget(manifest.topicId, file.relativePath);
        const current = await readOptional(target);
        if (relativeFingerprint(current) !== file.targetRevision) throw new TransactionConflictError(`target verification failed: ${file.relativePath}`, { relativePath: file.relativePath, operationId: manifest.operationId });
      }
      await this.#inject('before-commit-marker', request, manifest);
      const committedAt = now();
      await writeDurable(path.join(transactionPath, 'commit.json'), jsonBytes({ operationId: manifest.operationId, updateId: manifest.updateId, committedAt, targetRevisions: Object.fromEntries(manifest.files.map((file) => [file.relativePath, file.targetRevision])) }));
      await this.#inject('after-commit-marker', request, manifest);
      manifest = { ...manifest, status: 'committed', committedAt };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
      const result = { status: 'committed', saved: true, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, committedAt, targetRevisions: Object.fromEntries(manifest.files.map((file) => [file.relativePath, file.targetRevision])), noOp: manifest.noOp };
      await this.#inject('before-operation-record', request, result);
      await writeDurable(operationPath, jsonBytes({ ...transaction.operation, status: 'committed', saved: true, committedAt, result }));
      await this.#inject('after-operation-record', request, result);
      return result;
    } catch (error) {
      if (error instanceof TransactionConflictError) {
        await this.#rollbackApplied(transaction, manifest).catch(() => {});
        const conflict = { status: 'conflict', saved: false, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, error: error.message, details: error.details, resolved: false };
        manifest = { ...manifest, status: 'conflict', conflictAt: now(), error: conflict };
        await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
        await writeDurable(operationPath, jsonBytes({ ...transaction.operation, status: 'conflict', saved: false, result: conflict }));
        return conflict;
      }
      const failure = { status: 'pending', saved: false, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, error: error.message, recoverable: true };
      await writeDurable(operationPath, jsonBytes({ ...transaction.operation, status: 'pending', saved: false, lastError: failure }));
      if (error === FAILURE || error?.code === 'injected-failure') throw new TransactionError(error.message || 'deterministic failure injection', failure);
      throw error;
    }
  }

  async #checkExpected(manifest, request) {
    const mismatches = [];
    for (const file of manifest.files) {
      const current = await readOptional(this.#secureTarget(manifest.topicId, file.relativePath));
      const actual = relativeFingerprint(current);
      if (actual !== file.baseRevision && actual !== file.targetRevision) mismatches.push({ relativePath: file.relativePath, expected: file.baseRevision, actual });
    }
    if (mismatches.length) throw new TransactionConflictError('expected revision does not match current content', { operationId: manifest.operationId, mismatches });
    if (request.expectedRevisions) {
      for (const [relativePath, expected] of Object.entries(request.expectedRevisions)) {
        if (!manifest.files.some((file) => file.relativePath === relativePath)) {
          const actual = relativeFingerprint(await readOptional(this.#secureTarget(request.topicId, relativePath)));
          if (actual !== expected) throw new TransactionConflictError(`read-set changed: ${relativePath}`, { relativePath, expected, actual });
        }
      }
    }
  }

  async #rollbackApplied(transaction, manifest) {
    for (const file of manifest.files || []) {
      if (!file.applied) continue;
      const target = this.#secureTarget(manifest.topicId, file.relativePath);
      const current = await readOptional(target);
      if (relativeFingerprint(current) !== file.targetRevision) continue;
      const original = await fs.readFile(path.join(transaction.transactionPath, file.originalPath)).catch(() => null);
      if (original === null) continue;
      if (file.baseRevision === null) await fs.unlink(target).catch(() => {});
      else await this.#atomicReplace(target, original, `${manifest.operationId}-rollback`, file.index);
    }
  }

  async #atomicReplace(target, bytes, operationId, index) {
    await mkdirp(path.dirname(target));
    const temporary = `${target}.lattice-${operationId}-${index}.tmp`;
    await fs.unlink(temporary).catch(() => {});
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  }

  #secureTarget(topicId, relativePath) {
    assertTopicId(topicId);
    try { assertIndexedPath(topicId, relativePath); }
    catch { throw new RepositoryError('invalid', `transaction path is outside topic: ${relativePath}`); }
    if (relativePath.endsWith('/README.md')) throw new RepositoryError('invalid', 'README projections are not transaction targets');
    return resolveVaultPath(this.root, relativePath);
  }

  #validateRequest(input) {
    if (!input || typeof input !== 'object') throw new RepositoryError('invalid', 'transaction request is required');
    const topicId = assertTopicId(input.topicId);
    const operationId = assertOperationId(input.operationId, 'operationId');
    const updateId = assertOperationId(input.updateId, 'updateId');
    const origin = input.origin === 'user' || input.origin === 'reducer' ? input.origin : null;
    if (!origin) throw new RepositoryError('invalid', 'origin must be user or reducer');
    if (!Array.isArray(input.files) || input.files.length === 0 && !input.noOp) throw new RepositoryError('invalid', 'transaction files are required');
    const expectedRevisions = input.expectedRevisions && typeof input.expectedRevisions === 'object' ? { ...input.expectedRevisions } : {};
    const seen = new Set();
    const files = (input.files || []).map((entry) => {
      if (!entry || typeof entry.relativePath !== 'string' || seen.has(entry.relativePath)) throw new RepositoryError('invalid', 'transaction files must have unique relative paths');
      seen.add(entry.relativePath);
      if (entry.content === undefined || entry.content === null) throw new RepositoryError('invalid', `missing content for ${entry.relativePath}`);
      this.#secureTarget(topicId, entry.relativePath);
      return fileEntry(entry.relativePath, entry.content);
    });
    return { topicId, operationId, updateId, origin, files, expectedRevisions, noOp: Boolean(input.noOp), metadata: input.metadata && typeof input.metadata === 'object' ? structuredClone(input.metadata) : {} };
  }

  #validateStateAfterImage(bytes, topicId, vaultId) {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new RepositoryError('invalid', 'state after-image is malformed JSON'); }
    if (value.documentType !== 'topic-state' || value.id !== topicId) throw new RepositoryError('invalid', 'state after-image has invalid topic identity');
    if (vaultId && value.vaultId !== vaultId) throw new RepositoryError('invalid', 'state after-image has invalid vault identity');
  }

  #validateLogicalFiles(request, snapshot, stateEntry) {
    const nonState = request.files.filter((entry) => entry.relativePath !== snapshot.statePath);
    if (nonState.length && !stateEntry) throw new RepositoryError('invalid', 'note/session writes must include the state after-image');
    if (!stateEntry) return;
    let state;
    try { state = JSON.parse(stateEntry.bytes.toString('utf8')); }
    catch { throw new RepositoryError('invalid', 'state after-image is malformed JSON'); }
    for (const entry of nonState) {
      const kind = entry.relativePath.includes('/notes/') ? 'notes' : entry.relativePath.includes('/sessions/') ? 'sessions' : null;
      if (!kind) throw new RepositoryError('invalid', `unsupported transaction target: ${entry.relativePath}`);
      const indexed = Object.values(state[kind] || {}).find((candidate) => candidate?.path === entry.relativePath);
      if (!indexed) throw new RepositoryError('invalid', `${kind} after-image is not indexed by state after-image`);
    }
  }

  async #findUpdate(updateId) {
    const entries = await fs.readdir(this.operationsRoot).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const operation = await readJsonFile(path.join(this.operationsRoot, entry));
      if (operation?.updateId === updateId && operation.status === 'committed') return operation.result;
    }
    return null;
  }

  async #inject(stage, request, context) {
    if (!this.failureInjector) return;
    try {
      const result = await this.failureInjector(stage, { operationId: request.operationId, topicId: request.topicId, ...context });
      if (result === true || result === stage) throw new Error(`deterministic failure at ${stage}`);
    } catch (error) {
      const injected = new Error(error.message || `deterministic failure at ${stage}`);
      injected.code = 'injected-failure';
      injected.stage = stage;
      throw injected;
    }
  }
}

export function createRepository(vaultRoot, options) { return new VaultRepository(vaultRoot, options); }
