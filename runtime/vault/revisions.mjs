import crypto from 'node:crypto';

export function blobRevision(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}
