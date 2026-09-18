#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = process.argv[2];
if (!root) {
  console.error('usage: node tests/vault_live_probe.js <learning-vault-root>');
  process.exit(2);
}
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('.learning-vault/vault.json'));
const blobRevision = (text) => {
  const bytes = Buffer.from(text);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
function snapshot(directory) {
  const entries = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else entries.push([path.relative(directory, absolute), blobRevision(fs.readFileSync(absolute))]);
    }
  }
  visit(directory);
  return JSON.stringify(entries.sort());
}
const beforeSnapshot = snapshot(root);
let topicCount = 0;
let noteCount = 0;
let sessionCount = 0;
let roadmapCount = 0;
let projectionMarkers = 0;
let staleProjectionMarkers = 0;
for (const [topicId, binding] of Object.entries(manifest.topics)) {
  const state = JSON.parse(read(binding.statePath));
  if (state.id !== topicId || state.vaultId !== manifest.vaultId || state.documentType !== 'topic-state') {
    throw new Error(`invalid binding for topic ${topicId}`);
  }
  topicCount += 1;
  noteCount += Object.keys(state.notes || {}).length;
  sessionCount += Object.keys(state.sessions || {}).length;
  roadmapCount += Array.isArray(state.roadmap) ? 1 : 0;
  const readmePath = path.join(root, 'topics', topicId, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const marker = readme.match(/(?:Source Topic(?: state|-state) blob SHA|source-sha): `?([0-9a-f]{40})`?/i);
    if (marker) {
      projectionMarkers += 1;
      if (marker[1] !== blobRevision(read(binding.statePath))) staleProjectionMarkers += 1;
    }
  }
  for (const [id, entry] of Object.entries(state.notes || {})) {
    if (entry.id !== id || !entry.path.startsWith(`topics/${topicId}/`)) throw new Error(`invalid note identity in ${topicId}`);
  }
  for (const [id, entry] of Object.entries(state.sessions || {})) {
    if (entry.id !== id || !entry.path.startsWith(`topics/${topicId}/`)) throw new Error(`invalid session identity in ${topicId}`);
  }
}
const afterSnapshot = snapshot(root);
if (beforeSnapshot !== afterSnapshot) throw new Error('vault files changed during read-only probe');
console.log(JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  documentType: manifest.documentType,
  topicCount,
  noteCount,
  sessionCount,
  topicsWithRoadmap: roadmapCount,
  projectionMarkers,
  staleProjectionMarkers,
  worktreeUnchanged: true,
}));
