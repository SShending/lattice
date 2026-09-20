import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, serveStatic } from './http-api.mjs';
import { VaultReader } from '../runtime/vault/reader.mjs';
import { VaultRepository } from '../runtime/vault/repository.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', 'web');

export function createServer({ vaultRoot, host = '127.0.0.1', port = 4317, repositoryOptions = {} } = {}) {
  if (!vaultRoot) throw new Error('vaultRoot is required');
  // Derive the accepted same-origin URL from the bound loopback socket, not
  // from a caller-controlled Host header.
  const origin = (request) => `http://127.0.0.1:${request.socket.localPort}`;
  const repository = new VaultRepository(vaultRoot, repositoryOptions);
  const api = createApi({ reader: new VaultReader(vaultRoot), repository, origin });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      if (await api(request, response, url.pathname)) return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (await serveStatic(response, url.pathname, webRoot)) return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  const closeHttpServer = server.close.bind(server);
  server.close = (callback) => closeHttpServer((error) => {
    repository.close().then(
      () => callback?.(error),
      (closeError) => callback?.(error || closeError),
    );
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const vaultRoot = process.env.LATTICE_VAULT_ROOT || path.resolve(process.cwd(), '../learning-vault');
  const host = '127.0.0.1';
  const port = Number(process.env.PORT || 4317);
  const server = createServer({ vaultRoot, host, port });
  server.listen(port, host, () => console.log(`Lattice listening at http://${host}:${port}`));
}
