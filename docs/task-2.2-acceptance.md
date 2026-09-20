# Task 2.2 independent acceptance: FAIL

Reviewed 2026-09-20 on VS Code SSH mint, uncommitted workspace after c7511e3. Independent npm test: 60 passed, 0 failed, 0 skipped. No implementation code changed.

## P1: Application cannot boot
server/http-api.mjs:77 serves note-drafts.mjs as text/html although web/app.js:1 imports it as a JavaScript module. HEAD returned 200 text/html; browser remained at Loading vault. Add .mjs MIME support and a real browser boot smoke test.

## P1: Save completion loses subsequent input
web/app.js:325-361, especially 350-355. In synthetic temporary server ONLY, correct MIME header and delay PUT response by 5 seconds. Submit body A, then type B while Saving. B appears, but response clears dirty and re-renders A with Saved. Observed in browser. Capture submitted payload/version and preserve edits made during the request; advance saved baseline without clearing newer drafts; separate in-flight guard from editable status. Test delayed response, continued typing, repeated save and navigation.

## P2: Unsaved edits still display Saved
web/app.js:234,321. After successful save, edit Markdown. Badge still says Saved and old success message remains. updateDraft searches inside form for data-note-status, but badge is outside form. Update actual badge and clear stale success feedback. Test actual DOM state transitions.

## Partial passing evidence and limits
With MIME workaround in temporary audit server, competing browser tab save plus Refresh correctly preserved the first tab draft and displayed Conflict. Full visual/restart/conflict-resolution acceptance remains incomplete. Browser reload draft loss is already documented and not counted as another blocker. Existing tests miss module MIME and real asynchronous editor behavior.

Recommend Task 2.2 remain in progress until blockers are fixed and browser checks pass. Do not commit/push this candidate or start Phase 3/4. Synthetic fixtures only; temporary server is separate from real learning-vault.
