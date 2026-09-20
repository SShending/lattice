import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultReadError } from '../runtime/vault/reader.mjs';
import { RepositoryError } from '../runtime/vault/repository.mjs';
import { projectTopic } from '../runtime/vault/projections.mjs';

const sameOrigin = (request, origin) => !request.headers.origin || request.headers.origin === origin(request);

const MAX_BODY_BYTES = 1024 * 1024 + 8192;

export function createApi({ reader, repository, origin }) {
  return async function api(request, response, pathname) {
    const noteMatch = pathname.match(/^\/api\/topics\/([^/]+)\/notes\/([^/]+)$/);
    if (request.method !== 'GET' && request.method !== 'HEAD' && !noteMatch) {
      if (!sameOrigin(request, origin)) return sendJson(response, 403, { error: 'cross-origin mutation rejected' });
      return sendJson(response, 405, { error: 'read-only Task 1.1 server; mutations are unavailable' }, { allow: 'GET, HEAD' });
    }
    try {
      if (noteMatch) {
        if (!sameOrigin(request, origin)) return sendJson(response, 403, { error: 'cross-origin mutation rejected' });
        if (request.method !== 'PUT') return sendJson(response, 405, { error: 'note edits require PUT' }, { allow: 'PUT' });
        if (!repository) return sendJson(response, 503, { error: 'unavailable', message: 'note editing is unavailable' });
        const input = await readJsonBody(request);
        const topicId = decodeURIComponent(noteMatch[1]);
        const noteId = decodeURIComponent(noteMatch[2]);
        if (input.topicId !== undefined && input.topicId !== topicId) return sendJson(response, 400, { error: 'invalid', message: 'topicId does not match the URL' });
        if (input.noteId !== undefined && input.noteId !== noteId) return sendJson(response, 400, { error: 'invalid', message: 'noteId does not match the URL' });
        const result = await repository.saveNote({ ...input, topicId, noteId });
        const status = result.status === 'conflict' ? 409 : result.status === 'committed' || result.status === 'duplicate' ? 200 : 500;
        return sendJson(response, status, result);
      }
      if (pathname === '/api/health') return sendJson(response, 200, { status: 'ready', codex: 'unavailable', writable: true, notes: 'available', understanding: 'read-only' });
      if (pathname === '/api/topics') return sendJson(response, 200, repository ? await repository.listTopics() : await reader.listTopics());
      const match = pathname.match(/^\/api\/topics\/([^/]+)$/);
      if (match) {
        const topic = repository ? await repository.snapshot(decodeURIComponent(match[1])) : await reader.readTopic(decodeURIComponent(match[1]));
        return sendJson(response, 200, projectTopic(topic));
      }
      return false;
    } catch (error) {
      if (error instanceof VaultReadError) return sendJson(response, error.code === 'invalid' ? 404 : 422, { error: error.code, message: error.message, details: error.details });
      if (error instanceof RepositoryError) {
        const status = error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : error.code === 'recovery-required' || error.code === 'writer-locked' ? 503 : error.code === 'closed' ? 503 : 500;
        return sendJson(response, status, { error: error.code, message: error.message, details: error.details });
      }
      return sendJson(response, 500, { error: 'unavailable', message: 'vault unavailable' });
    }
  };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RepositoryError('invalid', 'request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) throw new RepositoryError('invalid', 'request body is required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RepositoryError('invalid', 'request body must be valid JSON'); }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  response.end(body);
  return true;
}

export async function serveStatic(response, pathname, webRoot) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const absolute = path.resolve(webRoot, relative);
  if (absolute !== path.resolve(webRoot) && !absolute.startsWith(`${path.resolve(webRoot)}${path.sep}`)) return false;
  try {
    const body = await fs.readFile(absolute);
    const extension = path.extname(absolute);
    const type = extension === '.css' ? 'text/css'
      : extension === '.js' || extension === '.mjs' ? 'text/javascript'
        : 'text/html';
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    response.end(body);
    return true;
  } catch { return false; }
}
