import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/main.mjs';
import { VaultReader } from '../runtime/vault/reader.mjs';
import { projectTopic, renderMarkdown, resolveNotePreview, resolveNoteTitle } from '../runtime/vault/projections.mjs';
import { resolveVaultPath } from '../runtime/vault/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'vault');

function request(server, method, pathname, headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname, headers }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }));
    }); req.on('error', reject); req.end();
  });
}

async function withServer(fn) {
  const server = createServer({ vaultRoot: fixtureRoot, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('four read-only views are backed by topic-isolated API data', async () => {
  await withServer(async (server) => {
    const topics = await request(server, 'GET', '/api/topics');
    assert.equal(topics.status, 200); assert.equal(topics.json().topics.length, 2);
    const complete = await request(server, 'GET', '/api/topics/complete-topic');
    assert.equal(complete.status, 200); assert.equal(complete.json().id, 'complete-topic');
    assert.equal(complete.json().roadmap[0].futureMilestone, 7);
    assert.equal(complete.json().unknownFields.includes('futureTopLevelField'), true);
    assert.equal(complete.json().concepts[0].name, 'Lossless mapping');
    assert.equal(complete.json().notes[0].title, 'Synthetic Note');
    assert.equal(complete.json().notes[0].html.includes('<h1>Synthetic Note</h1>'), false);
    assert.equal(complete.json().notes[0].html.includes('opaque to the repository mapper'), true);
    const legacy = await request(server, 'GET', '/api/topics/legacy-topic');
    assert.equal(legacy.status, 200); assert.equal(legacy.json().roadmap, null);
    assert.deepEqual(legacy.json().state.misconceptions, []);
    assert.deepEqual(legacy.json().evidence, []);
    assert.equal((await request(server, 'GET', '/api/topics/%2e%2e%2flegacy-topic')).status, 404);
  });
});

test('optional learner-state fields degrade to honest empty projections', () => {
  const projection = projectTopic({
    id: 'sparse-topic',
    state: { id: 'sparse-topic', title: 'Sparse topic' },
    stateRevision: 'sparse-revision',
    manifestRevision: 'manifest-revision',
  });
  assert.deepEqual(projection.state.unassessed, []);
  assert.deepEqual(projection.state.misconceptions, []);
  assert.deepEqual(projection.state.knownGaps, []);
  assert.deepEqual(projection.concepts, []);
  assert.deepEqual(projection.evidence, []);
  assert.equal(projection.roadmap, null);
  assert.deepEqual(projection.notes, []);
  assert.deepEqual(projection.sessions, []);
  const withEvidence = projectTopic({ id: 'evidence-topic', state: { evidence: [{ summary: 'A recorded explanation', result: 'pass' }] } });
  assert.equal(withEvidence.evidence[0].summary, 'A recorded explanation');
});

test('note titles prefer metadata, then the first heading, then a humanized filename', () => {
  assert.equal(resolveNoteTitle({ id: 'metadata-note', index: { title: 'Explicit title' }, body: '# Markdown title' }), 'Explicit title');
  assert.equal(resolveNoteTitle({ id: 'heading-note', index: {}, body: 'Intro\n\n## First heading\n\nBody' }), 'First heading');
  assert.equal(resolveNoteTitle({ id: 'tool-request-execution', index: { path: 'topics/x/notes/tool-request-execution.md' }, body: 'Body only' }), 'Tool Request Execution');
  assert.equal(resolveNotePreview('# Heading\n\nLLM produces a tool call as an action request.'), 'LLM produces a tool call as an action request.');
  assert.equal(resolveNotePreview('# Heading'), '');
});

test('note rendering suppresses only a leading heading that duplicates the resolved title', () => {
  const duplicate = projectTopic({
    id: 'notes-topic',
    state: {},
    notes: [{ id: 'same-heading', index: { title: 'Runtime context' }, body: '# Runtime context\n\nCore model' }],
  });
  assert.equal(duplicate.notes[0].html.includes('<h1>Runtime context</h1>'), false);
  assert.equal(duplicate.notes[0].html.includes('<p>Core model</p>'), true);

  const meaningful = projectTopic({
    id: 'notes-topic',
    state: {},
    notes: [{ id: 'different-heading', index: { title: 'Runtime context' }, body: '# A distinct introduction\n\nCore model' }],
  });
  assert.equal(meaningful.notes[0].html.includes('<h1>A distinct introduction</h1>'), true);
});

test('reader exposes unknown source fields without normalizing them away', async () => {
  const topic = await new VaultReader(fixtureRoot).readTopic('complete-topic');
  assert.equal(topic.state.futureTopLevelField.must, 'survive');
  assert.deepEqual(topic.state.concepts['lossless-mapping'].futureConceptField, { keep: [1, 2, 3] });
  assert.equal(topic.state.notes['synthetic-note'].futureNoteIndexField, 'keep');
});

test('malformed state is reported without crashing the server', async () => {
  const reader = new VaultReader(path.join(here, 'fixtures', 'vault-malformed'));
  const result = await reader.listTopics();
  assert.equal(result.topics[0].status, 'invalid');
  assert.match(result.topics[0].error, /malformed JSON/);
});

test('path containment rejects traversal and hostile Markdown is inert', () => {
  assert.throws(() => resolveVaultPath(fixtureRoot, '../outside.json'), /escapes configured root/);
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
  assert.equal(html.includes('<script>'), false); assert.equal(html.includes('javascript:'), false); assert.equal(html.includes('&lt;script&gt;'), true);
});

test('Markdown renders ordered, unordered, and nested lists as coherent list structures', () => {
  const html = renderMarkdown('1. First step\n2. Second with `code`\n   - Nested detail\n   - Another detail\n3. Third step\n\nParagraph after.');
  assert.match(html, /<ol>[\s\S]*<li>First step<\/li>[\s\S]*<li>Second with <code>code<\/code>[\s\S]*<ul>[\s\S]*<li>Nested detail<\/li>[\s\S]*<li>Another detail<\/li>[\s\S]*<\/ul>[\s\S]*<\/li>[\s\S]*<li>Third step<\/li>[\s\S]*<\/ol>/);
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.match(html, /<p>Paragraph after\.<\/p>/);
});

test('cross-origin mutation is rejected and all mutations remain disabled', async () => {
  await withServer(async (server) => {
    const cross = await request(server, 'POST', '/api/topics/complete-topic', { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const same = await request(server, 'POST', '/api/topics/complete-topic', { origin: `http://127.0.0.1:${server.address().port}` });
    assert.equal(same.status, 405);
    const spoofedHost = await request(server, 'POST', '/api/topics/complete-topic', { host: 'evil.example', origin: 'http://evil.example' });
    assert.equal(spoofedHost.status, 403);
  });
});

test('topic selection is global context and the removed Topics view is not rendered', async () => {
  const index = await fs.readFile(path.join(here, '..', 'web', 'index.html'), 'utf8');
  const app = await fs.readFile(path.join(here, '..', 'web', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(here, '..', 'web', 'styles.css'), 'utf8');
  assert.match(index, /id="topic-select"/);
  assert.match(index, /href="#understanding"/);
  assert.doesNotMatch(index, /data-view="topics"/);
  assert.doesNotMatch(index, /rail-context/);
  assert.doesNotMatch(index, /topbar-topic-meta/);
  assert.match(app, /setActiveTopic\(select\.value\)/);
  assert.match(app, /view = location\.hash\.slice\(1\) \|\| 'study'/);
  assert.match(app, /pageHeader\(topic, 'STUDY', topic\.title/);
  assert.doesNotMatch(app, /topbarTopicMeta/);
  assert.doesNotMatch(app, /href="#state"/);
  assert.match(styles, /\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.topbar-identity\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.topbar-topic select\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(styles, /\.nav-item\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /\.nav-item small\s*\{[^}]*word-break:\s*normal[^}]*overflow-wrap:\s*normal/);
  assert.match(styles, /\.study-signals\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.readonly-badge\s*\{[^}]*display:\s*inline-flex/);
  assert.match(styles, /:focus-visible/);
  assert.match(app, /scrollIntoView/);
  assert.match(app, /aria-controls="roadmap-detail"/);
  assert.doesNotMatch(app, /stage-glyph/);
  assert.match(app, /Topic complete/);
  assert.match(app, /milestones demonstrated/);
  assert.match(app, /Historical checkpoint/);
  assert.match(app, /<details class="source-details">/);
});

test('Roadmap selection is a lightweight node state without changing the timeline row layout', async () => {
  const styles = await fs.readFile(path.join(here, '..', 'web', 'styles.css'), 'utf8');
  const app = await fs.readFile(path.join(here, '..', 'web', 'app.js'), 'utf8');
  assert.match(styles, /\.path-item\.selected \.path-button\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/);
  assert.match(styles, /\.path-item\.selected \.path-node\s*\{[^}]*box-shadow:/);
  assert.match(styles, /\.path-item\.selected \.path-node\s*\{[^}]*box-shadow:\s*0 0 0 [^,]+ var\(--white\),\s*0 0 0 [^ ]+ var\(--line-strong\)/);
  assert.match(styles, /\.path-item\.selected \.path-copy strong\s*\{[^}]*font-weight:\s*700/);
  assert.match(styles, /\.path-button:hover\s*\{[^}]*background:/);
  assert.match(styles, /\.path-button:focus-visible/);
  assert.doesNotMatch(styles, /\.path-item\.selected \.path-button\s*\{[^}]*inset/);
  assert.match(app, /aria-controls="roadmap-detail"/);
  assert.match(app, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
});

test('Study completion and checkpoint presentation stay compact and factual', async () => {
  const app = await fs.readFile(path.join(here, '..', 'web', 'app.js'), 'utf8');
  const styles = await fs.readFile(path.join(here, '..', 'web', 'styles.css'), 'utf8');
  const projection = projectTopic({
    id: 'history-topic',
    state: { title: 'History', currentFocus: 'History is complete.', nextStep: 'Review the next topic.', sessions: { checkpoint: { id: 'checkpoint', createdAt: '2026-09-18' } } },
    sessions: [{ id: 'checkpoint-1', index: { createdAt: '2026-09-18' }, revision: 'body-rev', body: '# Checkpoint title\n\nA short historical summary.\n\nUpdate ID: `update-1`\nBase state revision: `base-1`' }],
  });
  assert.equal(projection.sessions[0].title, 'Checkpoint title');
  assert.equal(projection.sessions[0].preview, 'A short historical summary.');
  assert.equal(projection.sessions[0].source.updateId, 'update-1');
  assert.equal(projection.sessions[0].source.baseRevision, 'base-1');
  assert.doesNotMatch(projection.sessions[0].html, /Update ID/);
  assert.match(app, /complete \? `<div class="completion-banner"/);
  assert.match(app, /explicitTopicComplete\(topic\) \? ''/);
  assert.match(app, /class="checkpoint-entry"/);
  assert.match(app, /class="source-details checkpoint-source-details"/);
  assert.match(app, /path-preview-link/);
  assert.doesNotMatch(app, /sessions\.slice\(0, 3\)/);
  assert.match(styles, /\.checkpoint-entry\s*\{/);
  assert.match(styles, /\.checkpoint-summary-line\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.checkpoint-entry > summary::before\s*\{[^}]*grid-column:\s*1/);
  assert.match(styles, /\.path-preview-link\s*\{[^}]*white-space:\s*nowrap/);
});

test('switching the global topic context changes the projection without a Topics route', async () => {
  await withServer(async (server) => {
    const first = await request(server, 'GET', '/api/topics/complete-topic');
    const second = await request(server, 'GET', '/api/topics/legacy-topic');
    assert.equal(first.json().id, 'complete-topic');
    assert.equal(second.json().id, 'legacy-topic');
    assert.notEqual(first.json().title, second.json().title);
    assert.equal((await request(server, 'GET', '/api/topics/%2e%2e%2ftopics')).status, 404);
  });
});

async function snapshotFiles(root) {
  const files = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push([child, await fs.readFile(path.join(root, child))]);
    }
  }
  await visit('');
  return files;
}

test('read-only API reads do not modify canonical fixture files', async () => {
  const before = await snapshotFiles(fixtureRoot);
  await withServer(async (server) => {
    await request(server, 'GET', '/api/topics');
    await request(server, 'GET', '/api/topics/complete-topic');
    await request(server, 'GET', '/api/topics/legacy-topic');
  });
  const after = await snapshotFiles(fixtureRoot);
  assert.deepEqual(after, before);
});
