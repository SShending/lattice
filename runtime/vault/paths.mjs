import path from 'node:path';

export function resolveVaultPath(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('vault path must be relative');
  }
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, relativePath);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('vault path escapes configured root');
  }
  return resolved;
}

export function assertTopicId(topicId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topicId)) throw new Error('invalid topic id');
  return topicId;
}

export function assertIndexedPath(topicId, relativePath) {
  assertTopicId(topicId);
  const expectedPrefix = `topics/${topicId}/`;
  if (!relativePath.startsWith(expectedPrefix)) throw new Error('indexed path is outside topic');
  return relativePath;
}
