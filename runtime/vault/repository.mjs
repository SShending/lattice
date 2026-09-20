import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertIndexedPath, assertTopicId, resolveVaultPath } from './paths.mjs';
import { VaultReader } from './reader.mjs';
import { blobRevision } from './revisions.mjs';

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION = /^[0-9a-f]{40}$/;

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

async function mkdirp(directory) {
  const missing = [];
  let cursor = path.resolve(directory);
  while (true) {
    try { await fs.stat(cursor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const target of missing.reverse()) {
    await fs.mkdir(target);
    await syncDirectory(target);
    await syncDirectory(path.dirname(target));
  }
}

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
    this.root = fsSync.realpathSync.native(path.resolve(vaultRoot));
    this.reader = options.reader || new VaultReader(this.root);
    this.stateRoot = options.stateRoot || homeStateRoot();
    this.metadataRoot = options.metadataRoot || operationalRoot(this.root, this.stateRoot);
    this.transactionsRoot = path.join(this.metadataRoot, 'transactions');
    this.operationsRoot = path.join(this.metadataRoot, 'operations');
    this.diagnosticsRoot = path.join(this.metadataRoot, 'diagnostics');
    this.lockPath = path.join(this.metadataRoot, 'writer.lock');
    this.failureInjector = options.failureInjector || null;
    this.lockProcess = null;
    this.lockToken = null;
    this.ready = false;
    this.queue = Promise.resolve();
    this.recoveryRequired = false;
    this.closing = false;
  }

  async initialize() {
    if (this.ready) return this;
    await mkdirp(this.transactionsRoot);
    await mkdirp(this.operationsRoot);
    await mkdirp(this.diagnosticsRoot);
    await this.acquireWriterLock();
    try { await this.#recover(); }
    catch (error) {
      await this.releaseWriterLock();
      throw error;
    }
    this.ready = true;
    return this;
  }

  async close() {
    if (this.closing) return this.queue;
    this.closing = true;
    return this.#enqueue(async () => {
      await this.releaseWriterLock();
      this.ready = false;
    }, { allowClosing: true });
  }

  async acquireWriterLock() {
    if (this.lockProcess) return;
    await mkdirp(this.metadataRoot);
    const child = spawn('flock', ['--exclusive', '--nonblock', this.lockPath, '/bin/sh', '-c', "printf 'locked\\n'; cat >/dev/null"], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new RepositoryError('lock-failed', 'writer lock helper did not become ready')), 5_000);
      const poll = () => {
        if (stdout.includes('locked\n')) { clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearTimeout(timeout); reject(new WriterLockError('another Lattice writer owns this vault', { lockPath: this.lockPath })); }
        else setTimeout(poll, 5);
      };
      child.once('error', (error) => { clearTimeout(timeout); reject(new RepositoryError('lock-failed', `unable to start flock: ${error.message}`)); });
      poll();
    }).catch(async (error) => {
      child.stdin.destroy();
      child.kill('SIGTERM');
      if (error instanceof WriterLockError) throw error;
      if (child.exitCode === 1) throw new WriterLockError('another Lattice writer owns this vault', { lockPath: this.lockPath });
      throw new RepositoryError(error.code || 'lock-failed', error.message, { stderr: stderr.trim() });
    });
    this.lockProcess = child;
    this.lockToken = crypto.randomUUID();
    await writeDurable(`${this.lockPath}.owner.json`, jsonBytes({ pid: process.pid, hostname: os.hostname(), acquiredAt: now(), token: this.lockToken, vaultRoot: this.root }));
  }

  async releaseWriterLock() {
    if (!this.lockProcess) return;
    const child = this.lockProcess;
    this.lockProcess = null;
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => child.kill('SIGTERM'), 1_000);
    });
    const owner = await readJsonFile(`${this.lockPath}.owner.json`).catch(() => null);
    if (owner?.token === this.lockToken) await fs.unlink(`${this.lockPath}.owner.json`).catch(() => {});
    this.lockToken = null;
    await syncDirectory(this.metadataRoot).catch(() => {});
  }

  async ensureReady() {
    if (!this.ready) await this.initialize();
  }

  #enqueue(work, { allowClosing = false } = {}) {
    if (this.closing && !allowClosing) return Promise.reject(new RepositoryError('closed', 'repository is closing'));
    const run = this.queue.catch(() => {}).then(work);
    this.queue = run;
    return run;
  }

  async snapshot(topicId) {
    await this.ensureReady();
    return this.#enqueue(async () => {
      if (this.recoveryRequired) await this.#recoverOrThrow();
      return this.#snapshot(topicId);
    });
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
    return this.#enqueue(async () => {
      if (this.recoveryRequired) await this.#recoverOrThrow();
      try { return await this.#commit(input); }
      catch (error) {
        if (error instanceof RepositoryError && ['invalid', 'schema', 'writer-locked', 'closed'].includes(error.code) && !error.afterCanonicalMutation) throw error;
        this.recoveryRequired = true;
        try { await this.#recoverOrThrow(); } catch {}
        throw error;
      }
    });
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
    await this.ensureReady();
    return this.#enqueue(() => this.#recover());
  }

  async #recoverOrThrow() {
    const outcomes = await this.#recover();
    const unresolved = outcomes.find((outcome) => outcome.status === 'pending' || outcome.status === 'conflict');
    if (unresolved) throw new RepositoryError('recovery-required', 'vault has an unresolved transaction', { outcomes });
    this.recoveryRequired = false;
  }

  async #recover() {
    await mkdirp(this.transactionsRoot);
    const entries = await fs.readdir(this.transactionsRoot, { withFileTypes: true });
    const outcomes = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !OPERATION_ID.test(entry.name)) continue;
      const transactionPath = path.join(this.transactionsRoot, entry.name);
      const manifest = await readJsonFile(path.join(transactionPath, 'manifest.json'));
      if (!manifest) continue;
      if (manifest.status === 'conflict') { outcomes.push({ status: 'conflict', operationId: manifest.operationId }); continue; }
      try {
        outcomes.push(await this.#recoverTransaction(transactionPath, manifest));
      } catch (error) {
        if (error instanceof TransactionConflictError) outcomes.push({ status: 'conflict', operationId: manifest.operationId, error: error.message });
        else throw error;
      }
    }
    this.recoveryRequired = outcomes.some((outcome) => outcome.status === 'pending' || outcome.status === 'conflict');
    return outcomes;
  }

  async #recoverTransaction(transactionPath, manifest) {
    const operationPath = path.join(this.operationsRoot, `${manifest.operationId}.json`);
    if (manifest.status === 'abandoned') return { status: 'abandoned', saved: false, operationId: manifest.operationId, replayed: true };
    if (manifest.status === 'staging') {
      const abandonedAt = now();
      const abandoned = { ...manifest, status: 'abandoned', abandonedAt, reason: 'staging did not produce a complete transaction manifest' };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(abandoned));
      const operation = await readJsonFile(operationPath) || manifest.operation || {};
      await writeDurable(operationPath, jsonBytes({ ...operation, status: 'abandoned', saved: false, result: { status: 'abandoned', saved: false, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, abandonedAt, recoverable: false } }));
      return { status: 'abandoned', saved: false, operationId: manifest.operationId, replayed: true };
    }
    const commitPath = path.join(transactionPath, 'commit.json');
    const commit = await readJsonFile(commitPath);
    if (commit) {
      const result = this.#committedResult(manifest, commit);
      const committed = { ...manifest, status: 'committed', committedAt: result.committedAt };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(committed));
      await writeDurable(operationPath, jsonBytes({ ...manifest.operation, status: 'committed', saved: true, committedAt: result.committedAt, result }));
      return { ...result, replayed: true };
    }
    const operation = await readJsonFile(operationPath) || manifest.operation;
    if (!operation) throw new RepositoryError('metadata-corrupt', `missing operation record: ${manifest.operationId}`);
    try {
      await this.#verifyStaged(transactionPath, manifest);
      return await this.#apply({ transactionPath, manifest, operation, request: this.#requestFromManifest(manifest) });
    } catch (error) {
      if (error?.code !== 'metadata-corrupt') throw error;
      const failure = { status: 'pending', saved: false, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, error: error.message, recoverable: false };
      const retained = { ...manifest, status: 'pending', recoveryRequired: true, lastError: failure };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(retained));
      await writeDurable(operationPath, jsonBytes({ ...operation, status: 'pending', saved: false, lastError: failure }));
      return failure;
    }
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
    if (existing.status === 'committed' && !existing.result) {
      const transactionPath = path.join(this.transactionsRoot, request.operationId);
      const manifest = await readJsonFile(path.join(transactionPath, 'manifest.json'));
      if (!manifest) throw new RepositoryError('metadata-corrupt', `missing transaction manifest: ${request.operationId}`);
      return this.#recoverTransaction(transactionPath, manifest);
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
      await this.#assertTargetSafe(request.topicId, entry.relativePath);
      const before = await readOptional(absolute);
      const expected = request.expectedRevisions[entry.relativePath];
      entries.push({
        index,
        relativePath: entry.relativePath,
        stagePath: `staged/${String(index).padStart(3, '0')}.bin`,
        originalPath: `original/${String(index).padStart(3, '0')}.bin`,
        baseRevision: expected,
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
      await this.#verifyStaged(transactionPath, manifest);
      await this.#checkExpected(manifest, request);
      manifest = { ...manifest, status: 'applying', applyingAt: now() };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
      await this.#inject('after-applying-marker', request, manifest);
      for (const file of manifest.files) {
        const target = this.#secureTarget(manifest.topicId, file.relativePath);
        await this.#assertTargetSafe(manifest.topicId, file.relativePath);
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
        if (blobRevision(stage) !== file.targetRevision) throw new RepositoryError('metadata-corrupt', `staged content fingerprint mismatch: ${file.relativePath}`);
        await this.#atomicReplace(target, stage, manifest.operationId, file.index);
        file.applied = true;
        await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
        await this.#inject('after-file-replace', request, file);
      }
      for (const file of manifest.files) {
        await this.#assertTargetSafe(manifest.topicId, file.relativePath);
        const target = this.#secureTarget(manifest.topicId, file.relativePath);
        const current = await readOptional(target);
        if (relativeFingerprint(current) !== file.targetRevision) throw new TransactionConflictError(`target verification failed: ${file.relativePath}`, { relativePath: file.relativePath, operationId: manifest.operationId });
      }
      await this.#verifyStaged(transactionPath, manifest);
      await this.#inject('before-commit-marker', request, manifest);
      const committedAt = now();
      const result = this.#committedResult(manifest, { committedAt, targetRevisions: Object.fromEntries(manifest.files.map((file) => [file.relativePath, file.targetRevision])) });
      await writeDurable(path.join(transactionPath, 'commit.json'), jsonBytes(result));
      await this.#inject('after-commit-marker', request, manifest);
      manifest = { ...manifest, status: 'committed', committedAt };
      await writeDurable(path.join(transactionPath, 'manifest.json'), jsonBytes(manifest));
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
      if (manifest.status === 'applying' || manifest.files?.some((file) => file.applied)) {
        error.afterCanonicalMutation = true;
      }
      const failure = { status: 'pending', saved: false, operationId: manifest.operationId, updateId: manifest.updateId, topicId: manifest.topicId, error: error.message, recoverable: true };
      await writeDurable(operationPath, jsonBytes({ ...transaction.operation, status: 'pending', saved: false, lastError: failure }));
      if (error?.code === 'injected-failure') throw new TransactionError(error.message || 'deterministic failure injection', failure);
      throw error;
    }
  }

  async #checkExpected(manifest, request) {
    const mismatches = [];
    for (const file of manifest.files) {
      await this.#assertTargetSafe(manifest.topicId, file.relativePath);
      const current = await readOptional(this.#secureTarget(manifest.topicId, file.relativePath));
      const actual = relativeFingerprint(current);
      const recoveryTarget = manifest.status === 'applying' && actual === file.targetRevision;
      if (actual !== file.baseRevision && !recoveryTarget) mismatches.push({ relativePath: file.relativePath, expected: file.baseRevision, actual });
    }
    if (mismatches.length) throw new TransactionConflictError('expected revision does not match current content', { operationId: manifest.operationId, mismatches });
    if (request.expectedRevisions) {
      for (const [relativePath, expected] of Object.entries(request.expectedRevisions)) {
        if (!manifest.files.some((file) => file.relativePath === relativePath)) {
          await this.#assertTargetSafe(request.topicId, relativePath);
          const actual = relativeFingerprint(await readOptional(this.#secureTarget(request.topicId, relativePath)));
          if (actual !== expected) throw new TransactionConflictError(`read-set changed: ${relativePath}`, { relativePath, expected, actual });
        }
      }
    }
  }

  async #rollbackApplied(transaction, manifest) {
    for (const file of manifest.files || []) {
      if (!file.applied) continue;
      await this.#assertTargetSafe(manifest.topicId, file.relativePath);
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
    const normalized = path.posix.normalize(relativePath);
    if (normalized !== relativePath || normalized.includes('\\')) throw new RepositoryError('invalid', `transaction path alias is not allowed: ${relativePath}`);
    const target = resolveVaultPath(this.root, relativePath);
    const topicRoot = resolveVaultPath(this.root, `topics/${topicId}`);
    const relative = path.relative(topicRoot, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new RepositoryError('invalid', `transaction path is outside topic: ${relativePath}`);
    return target;
  }

  async #assertTargetSafe(topicId, relativePath) {
    const target = this.#secureTarget(topicId, relativePath);
    const topicRoot = resolveVaultPath(this.root, `topics/${topicId}`);
    let cursor = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      cursor = path.join(cursor, segment);
      let stat;
      try { stat = await fs.lstat(cursor); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new RepositoryError('invalid', `transaction path contains a symbolic link: ${relativePath}`);
    }
    const topicReal = await fs.realpath(topicRoot);
    if (topicReal !== topicRoot) throw new RepositoryError('invalid', `topic path is not canonical: ${topicId}`);
  }

  async #verifyStaged(transactionPath, manifest) {
    for (const file of manifest.files || []) {
      await this.#assertTargetSafe(manifest.topicId, file.relativePath);
      const staged = await fs.readFile(path.join(transactionPath, file.stagePath)).catch(() => null);
      if (!staged || blobRevision(staged) !== file.targetRevision) {
        throw new RepositoryError('metadata-corrupt', `staged content fingerprint mismatch: ${file.relativePath}`);
      }
      const original = await fs.readFile(path.join(transactionPath, file.originalPath)).catch(() => null);
      if (!original || (file.observedRevision !== null && blobRevision(original) !== file.observedRevision) || (file.observedRevision === null && original.length !== 0)) {
        throw new RepositoryError('metadata-corrupt', `original content fingerprint mismatch: ${file.relativePath}`);
      }
    }
  }

  #validateRequest(input) {
    if (!input || typeof input !== 'object') throw new RepositoryError('invalid', 'transaction request is required');
    const topicId = assertTopicId(input.topicId);
    const operationId = assertOperationId(input.operationId, 'operationId');
    const updateId = assertOperationId(input.updateId, 'updateId');
    const origin = input.origin === 'user' || input.origin === 'reducer' ? input.origin : null;
    if (!origin) throw new RepositoryError('invalid', 'origin must be user or reducer');
    if (!Array.isArray(input.files) || input.files.length === 0) throw new RepositoryError('invalid', 'transaction files are required');
    if (!input.expectedRevisions || typeof input.expectedRevisions !== 'object' || Array.isArray(input.expectedRevisions)) throw new RepositoryError('invalid', 'expectedRevisions is required');
    const expectedRevisions = { ...input.expectedRevisions };
    const seen = new Set();
    const resolvedTargets = new Set();
    const files = (input.files || []).map((entry) => {
      if (!entry || typeof entry.relativePath !== 'string' || seen.has(entry.relativePath)) throw new RepositoryError('invalid', 'transaction files must have unique relative paths');
      seen.add(entry.relativePath);
      if (entry.content === undefined || entry.content === null) throw new RepositoryError('invalid', `missing content for ${entry.relativePath}`);
      const target = this.#secureTarget(topicId, entry.relativePath);
      if (resolvedTargets.has(target)) throw new RepositoryError('invalid', `duplicate transaction target: ${entry.relativePath}`);
      resolvedTargets.add(target);
      if (!Object.hasOwn(expectedRevisions, entry.relativePath)) throw new RepositoryError('invalid', `missing expected revision for ${entry.relativePath}`);
      const expected = expectedRevisions[entry.relativePath];
      if (expected !== null && (typeof expected !== 'string' || !REVISION.test(expected))) throw new RepositoryError('invalid', `invalid expected revision for ${entry.relativePath}`);
      return fileEntry(entry.relativePath, entry.content);
    });
    for (const [relativePath, expected] of Object.entries(expectedRevisions)) {
      this.#secureTarget(topicId, relativePath);
      if (expected !== null && (typeof expected !== 'string' || !REVISION.test(expected))) throw new RepositoryError('invalid', `invalid expected revision for ${relativePath}`);
    }
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
    for (const kind of ['notes', 'sessions']) {
      const before = snapshot.state[kind] || {};
      const after = state[kind] || {};
      for (const [id, index] of Object.entries(after)) {
        if (!index || index.id !== id || typeof index.path !== 'string') throw new RepositoryError('invalid', `invalid ${kind} index entry: ${id}`);
        const changed = !Object.hasOwn(before, id) || before[id]?.path !== index.path;
        if (changed && !request.files.some((entry) => entry.relativePath === index.path)) throw new RepositoryError('invalid', `required ${kind} file is missing: ${index.path}`);
      }
    }
    if (request.origin === 'reducer') {
      const addedSessions = Object.entries(state.sessions || {}).filter(([id]) => !Object.hasOwn(snapshot.state.sessions || {}, id));
      if (addedSessions.length === 0) throw new RepositoryError('invalid', 'reducer transaction requires a new checkpoint');
      if (request.noOp) {
        const beforeLearning = structuredClone(snapshot.state);
        const afterLearning = structuredClone(state);
        delete beforeLearning.sessions;
        delete afterLearning.sessions;
        if (JSON.stringify(beforeLearning) !== JSON.stringify(afterLearning)) throw new RepositoryError('invalid', 'no-op may only add checkpoint state');
      }
    }
  }

  #committedResult(manifest, commit) {
    return {
      status: 'committed',
      saved: true,
      operationId: manifest.operationId,
      updateId: manifest.updateId,
      topicId: manifest.topicId,
      committedAt: commit.committedAt,
      targetRevisions: commit.targetRevisions || Object.fromEntries(manifest.files.map((file) => [file.relativePath, file.targetRevision])),
      noOp: Boolean(manifest.noOp),
    };
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
