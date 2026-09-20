# Task 2.2 implementation evidence

Date: 2026-09-20  
Baseline: `c7511e3`  
Scope: Notes editor and read-only Understanding only

## Implemented behavior

- Notes can be created or edited through
  `PUT /api/topics/:topicId/notes/:noteId`.
- The server validates resource identity, request size, supported fields,
  note/body metadata bounds, operation IDs, and expected state/note revisions.
  It rejects cross-origin writes and owns `origin=user` provenance.
- `VaultRepository.saveNote()` preserves the complete existing state and note
  index entry, including unknown fields, and commits `state.json` plus the note
  Markdown through the Task 2.1 journal. New note paths are repository-derived.
- Duplicate operation delivery replays the durable result. Stale note or state
  revisions return conflict without overwriting newer content. `saved: true`
  is returned and displayed only after the durable commit barrier.
- The browser exposes draft, saving, saved, error, and conflict states. Drafts
  remain associated with their topic/note while navigating. Polling, focus,
  visibility, and explicit refresh detect incoming revisions; a dirty draft is
  retained and shown alongside the latest committed version. Dirty drafts
  trigger a browser unload warning.
- Understanding remains a read-only projection. No learner-state mutation
  endpoint, Understanding write command, or `state.json` editor was added.
  Learner-state correction remains assigned to the later Study/Reducer phase.

## Automated verification

All persistence tests copied `tests/fixtures/vault` into an `os.tmpdir()`
directory and used a separate temporary operational-state root. No fault or
write test targeted the real learning vault.

Commands and results:

```text
node --check web/app.js
node --test --test-reporter=spec tests/task_2_2.test.mjs
8 tests, 8 passed

node --test --test-reporter=spec \
  tests/task_1_1.test.mjs tests/persistence.test.mjs tests/task_2_2.test.mjs
37 tests, 37 passed

npm test
60 tests, 60 passed

git diff --check
passed
```

The Task 2.2 suite covers lossless edit/restart, new-note creation, provenance,
duplicate replay, invalid fields, stale note revision, stale state revision,
HTTP security/status behavior, absence of state/Understanding mutation routes,
and the browser draft/conflict/read-only contract.

## Browser-facing evidence

A loopback server was started against a copied synthetic vault and separate
temporary state directory. The following checks passed:

- `GET /api/health` returned `status=ready`, `notes=available`, and
  `understanding=read-only`.
- `GET /api/topics/complete-topic` returned the committed topic projection.
- `/`, `/app.js`, and `/styles.css` returned 200 with expected content types
  and `cache-control: no-store`.
- The HTTP integration test saved and reloaded a synthetic note, rejected a
  cross-origin save, and returned 405 for both `/state` and `/understanding`
  mutation attempts.

Automated headless Firefox screenshot capture was not usable in this runtime
because Firefox 154 reported `RenderCompositorSWGL failed mapping default
framebuffer`. Per user direction, manual visual and competing-tab acceptance
will be performed independently; no further browser automation is claimed.

## Current limits

- Drafts survive in-app topic/view navigation and incoming refreshes, but are
  not persisted across a completed browser reload; the browser warns before
  unloading a dirty draft.
- Existing-note deletion, Markdown preview editing, learner-state correction,
  Study/Reducer behavior, Codex integration, Git synchronization, and Phase
  3/4 functionality remain out of scope.
- The Understanding view reflects committed learner state only. A correction
  cannot be applied until the later Study/Reducer path exists.

## Second acceptance fixes (2026-09-20)

The independent acceptance report in `task-2.2-acceptance.md` is retained as
the historical baseline. Its three reproduced failures were fixed as follows:

- Static serving now returns `text/javascript` for both `.js` and `.mjs`.
  A real Chromium test loads the application modules, observes `Vault ready`,
  verifies the populated topic selector, and uses the Notes controls.
- A save now freezes an immutable payload, draft version, and operation/update
  IDs. The in-flight request is independent of editable status. A delayed A
  response advances the committed baseline without replacing B typed while it
  was pending. Duplicate submit is blocked; switching topic is isolated; the
  retained B draft is explicitly resumable. Saving B uses fresh IDs, while an
  unchanged failed request reuses its original IDs on retry.
- Editor input updates the actual status badge outside the form and clears
  stale success/error text immediately. Browser assertions cover draft,
  saving, saved, error, and conflict states.

The added Notes interaction contract is also implemented. Existing notes open
in a committed, safely rendered Markdown reading view with an Edit command.
The renderer preserves headings, lists, fenced code, quotes, and safe links;
raw HTML is escaped and dangerous links are not emitted. Edit mode has Save
and Cancel. Cancel confirms dirty changes and never writes; cancelling a new
note creates no file. A clean save returns to reading, while post-submit input
stays in the editor. Navigation retains dirty drafts, and the reading view
never presents draft text as committed content.

All browser and persistence cases copied `tests/fixtures/vault` to a temporary
directory and used a separate temporary operational-state root. No test wrote
to the real learning vault.

Second-round commands and results:

```text
node --test --test-reporter=spec \
  tests/task_2_2.test.mjs tests/task_2_2_browser.test.mjs
11 tests, 11 passed

npm test
63 tests, 63 passed (including 3 real Chromium scenarios)
```

The browser scenarios cover startup/module MIME, default reading, Edit,
confirmed Cancel, cancelled creation, creation/save/reload, safe Markdown,
delayed response with later typing, duplicate click, topic switch during save,
draft recovery, failed-request retry identity, competing-tab conflict, and the
absence of Understanding write controls.

Remaining limits are unchanged where applicable: drafts are in-memory and do
not survive an accepted full-page reload; existing-note deletion and conflict
merging are deferred. Understanding remains read-only and corrections still
belong to the later Study/Reducer task. Manual visual acceptance remains with
the user, but browser automation is no longer blocked.
