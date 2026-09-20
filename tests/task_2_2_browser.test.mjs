import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../server/main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'vault');

async function environment() {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-task-2-2-browser-'));
  const root = path.join(container, 'vault');
  const stateRoot = path.join(container, 'state');
  await fs.cp(fixtureRoot, root, { recursive: true });
  await fs.mkdir(stateRoot);
  const server = createServer({ vaultRoot: root, port: 0, repositoryOptions: { stateRoot } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { container, root, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function closeEnvironment(item) {
  await new Promise((resolve, reject) => item.server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(item.container, { recursive: true, force: true });
}

async function openNotes(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${url}/#notes`);
  await page.locator('#connection').filter({ hasText: 'Vault ready' }).waitFor();
  await page.locator('[data-note-markdown]').waitFor();
  assert.deepEqual(errors, []);
  return page;
}

async function edit(page) {
  await page.locator('[data-edit-note]').click();
  await page.locator('[data-note-form]').waitFor();
}

test('real browser boots modules and supports committed reading, edit, cancel, create, and safe Markdown reload', { timeout: 60_000 }, async () => {
  const item = await environment();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openNotes(browser, item.url);
    assert.ok(await page.locator('#topic-select option').count() >= 2);
    await page.locator('[data-note-markdown]').getByText('opaque to the repository mapper').waitFor();
    assert.equal(await page.locator('[data-note-form]').count(), 0);

    await edit(page);
    await page.locator('textarea[name=body]').fill('# Temporary draft\n');
    assert.equal(await page.locator('[data-note-status]').textContent(), 'Unsaved draft');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('[data-cancel-note]').click();
    assert.equal(await page.locator('[data-note-form]').count(), 1);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-cancel-note]').click();
    await page.locator('[data-note-markdown]').getByText('opaque to the repository mapper').waitFor();

    await page.locator('[data-new-note]').click();
    await page.locator('input[name=title]').fill('Browser Markdown');
    await page.locator('textarea[name=body]').fill('# Browser Markdown\n\n## Section\n\n- one\n- two\n\n> quoted\n\n```js\nconst ok = true;\n```\n\n[safe](https://example.com) [bad](javascript:window.__unsafe=1)\n\n<script>window.__unsafe = 2</script>\n');
    const notesBefore = await fs.readdir(path.join(item.root, 'topics', 'complete-topic', 'notes'));
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-cancel-note]').click();
    assert.deepEqual(await fs.readdir(path.join(item.root, 'topics', 'complete-topic', 'notes')), notesBefore);

    await page.locator('[data-new-note]').click();
    await page.locator('input[name=title]').fill('Browser Markdown');
    await page.locator('textarea[name=body]').fill('# Browser Markdown\n\n## Section\n\n- one\n- two\n\n> quoted\n\n```js\nconst ok = true;\n```\n\n[safe](https://example.com) [bad](javascript:window.__unsafe=1)\n\n<script>window.__unsafe = 2</script>\n');
    await page.locator('[data-save-note]').click();
    await page.locator('[data-note-markdown] h2').filter({ hasText: 'Section' }).waitFor();
    assert.equal(await page.locator('[data-note-status]').textContent(), 'Saved');
    assert.equal(await page.locator('[data-note-markdown] li').count(), 2);
    assert.equal(await page.locator('[data-note-markdown] blockquote').textContent(), 'quoted');
    assert.match(await page.locator('[data-note-markdown] pre').textContent(), /const ok = true/);
    assert.equal(await page.locator('[data-note-markdown] a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    await page.reload();
    await page.locator('[data-note]').filter({ hasText: 'Browser Markdown' }).click();
    await page.locator('[data-note-markdown] h2').filter({ hasText: 'Section' }).waitFor();
    assert.equal(await page.locator('[data-note-form]').count(), 0);
  } finally {
    await browser.close();
    await closeEnvironment(item);
  }
});

test('real browser preserves post-submit input, blocks duplicate saves, and restores drafts across navigation', { timeout: 60_000 }, async () => {
  const item = await environment();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openNotes(browser, item.url);
    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    const committedRequests = [];
    let putCount = 0;
    await page.route('**/api/topics/complete-topic/notes/synthetic-note', async (route, request) => {
      if (request.method() !== 'PUT') return route.continue();
      putCount += 1;
      committedRequests.push(JSON.parse(request.postData()));
      const response = await route.fetch();
      await responseGate;
      await route.fulfill({ response });
    });
    await edit(page);
    await page.locator('textarea[name=body]').fill('# Submitted A\n');
    await page.locator('[data-save-note]').click();
    await page.locator('[data-note-status]').filter({ hasText: 'Saving...' }).waitFor();
    await page.locator('textarea[name=body]').fill('# Later B\n');
    assert.equal(await page.locator('[data-note-status]').textContent(), 'Unsaved draft');
    await page.locator('[data-save-note]').click();
    assert.equal(putCount, 1);
    await page.locator('#topic-select').selectOption('legacy-topic');
    await page.getByRole('heading', { name: 'Knowledge library' }).waitFor();
    const baselineRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith('/api/topics/complete-topic'));
    releaseResponse();
    await baselineRefresh;
    assert.equal(committedRequests[0].body, '# Submitted A\n');

    await page.locator('#topic-select').selectOption('complete-topic');
    await page.locator('[data-draft-notice]').filter({ hasText: 'Unsaved draft available' }).waitFor();
    assert.equal(await page.locator('.note-reader-top h2').textContent(), 'Submitted A');
    assert.doesNotMatch(await page.locator('[data-note-markdown]').textContent(), /Later B/);
    await page.getByRole('button', { name: 'Continue editing' }).click();
    assert.equal(await page.locator('textarea[name=body]').inputValue(), '# Later B\n');
    await page.locator('[data-save-note]').click();
    await page.locator('.note-reader-top h2').filter({ hasText: 'Later B' }).waitFor();
    assert.equal(putCount, 2);
    assert.notEqual(committedRequests[0].operationId, committedRequests[1].operationId);
    assert.notEqual(committedRequests[0].updateId, committedRequests[1].updateId);
  } finally {
    await browser.close();
    await closeEnvironment(item);
  }
});

test('real browser isolates in-flight navigation, reuses failed request identity, and exposes conflicts', { timeout: 60_000 }, async () => {
  const item = await environment();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openNotes(browser, item.url);
    const attempts = [];
    await page.route('**/api/topics/complete-topic/notes/synthetic-note', async (route, request) => {
      if (request.method() !== 'PUT') return route.continue();
      attempts.push(JSON.parse(request.postData()));
      if (attempts.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected', message: 'Injected browser failure' }) });
      return route.continue();
    });
    await edit(page);
    await page.locator('textarea[name=body]').fill('# Retry body\n');
    await page.locator('[data-save-note]').click();
    await page.locator('[data-note-status]').filter({ hasText: 'Save failed' }).waitFor();
    assert.match(await page.locator('[data-note-message]').textContent(), /Injected browser failure/);
    const retryResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/notes/synthetic-note'));
    await page.locator('[data-save-note]').click();
    await retryResponse;
    await page.locator('.note-reader-top h2').filter({ hasText: 'Retry body' }).waitFor();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].operationId, attempts[1].operationId);
    assert.equal(attempts[0].updateId, attempts[1].updateId);

    const first = page;
    const second = await openNotes(browser, item.url);
    await edit(first);
    await first.locator('textarea[name=body]').fill('# First tab draft\n');
    await edit(second);
    await second.locator('textarea[name=body]').fill('# Second tab commit\n');
    await second.locator('[data-save-note]').click();
    await second.locator('.note-reader-top h2').filter({ hasText: 'Second tab commit' }).waitFor();
    await first.locator('[data-refresh-notes]').click();
    await first.locator('[data-note-status]').filter({ hasText: 'Conflict' }).waitFor();
    assert.equal(await first.locator('textarea[name=body]').inputValue(), '# First tab draft\n');
    assert.equal(await first.locator('[data-note-conflict]').count(), 1);

    await first.getByRole('link', { name: /Understanding/ }).click();
    await first.getByText('Read-only learner model').waitFor();
    assert.equal(await first.locator('textarea').count(), 0);
    assert.equal(await first.getByRole('button', { name: /save/i }).count(), 0);
  } finally {
    await browser.close();
    await closeEnvironment(item);
  }
});
