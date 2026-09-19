import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultReadError } from '../runtime/vault/reader.mjs';
import { projectTopic } from '../runtime/vault/projections.mjs';

const sameOrigin = (request, origin) => !request.headers.origin || request.headers.origin === origin(request);

export function createApi({ reader, origin }) {
  return async function api(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!sameOrigin(request, origin)) return sendJson(response, 403, { error: 'cross-origin mutation rejected' });
      return sendJson(response, 405, { error: 'read-only Task 1.1 server; mutations are unavailable' }, { allow: 'GET, HEAD' });
    }
    try {
      if (pathname === '/api/health') return sendJson(response, 200, { status: 'ready', codex: 'unavailable', writable: false });
      if (pathname === '/api/topics') return sendJson(response, 200, await reader.listTopics());
      const match = pathname.match(/^\/api\/topics\/([^/]+)$/);
      if (match) return sendJson(response, 200, projectTopic(await reader.readTopic(decodeURIComponent(match[1]))));
      return false;
    } catch (error) {
      if (error instanceof VaultReadError) return sendJson(response, error.code === 'invalid' ? 404 : 422, { error: error.code, message: error.message, details: error.details });
      return sendJson(response, 500, { error: 'unavailable', message: 'vault unavailable' });
    }
  };
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
    const type = absolute.endsWith('.css') ? 'text/css' : absolute.endsWith('.js') ? 'text/javascript' : 'text/html';
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    response.end(body);
    return true;
  } catch { return false; }
}
