# Lattice V0 development plan

## Current position

The repository contains the agreed product documentation plus the completed
Phase 0 contracts and the completed Phase 1 readable-vault shell. The user has
agreed to [the V0 direction](../INIT.md);
this plan replaces the former DSH integration sequence. Keep at most one task in
progress and attach acceptance evidence before marking it complete.

Source paths below are the selected module locations. Each phase depends on the preceding phase unless noted. Use synthetic or redacted vault fixtures.

## Phase 0 — Verify integration contracts

**Task 0.1 — Codex contract. Status: complete (2026-09-18).**

- Outcome: a reproducible, versioned App Server integration specification.
- Files: update `docs/architecture.md`; add `docs/codex-contract.md` with the tested version, prerequisites, exact protocol operations, permission profile, and reproducible smoke procedure.
- Work: inspect the installed Codex protocol/schema; verify stdio initialization, account status/ChatGPT login, thread start/resume, streaming, terminal error, interrupt, approval handling, and structured Reducer output. Verify canonical vault writes are denied to model tools. Decide isolated Tutor/Reducer thread handling and model configuration without hardcoding unsupported models.
- Verification: automated protocol smoke fixtures for success/error/unknown events; a manual account sign-in and interrupted turn. Record observed results and unsupported capabilities. Never record credentials.
- Acceptance: no uncertain completion/auth/permission behavior is hidden behind prompts; the supported version and adapter contract are documented.

  Evidence: [docs/codex-contract.md](codex-contract.md),
  `node tests/codex_protocol.test.js` (3 passing), and
  `node tests/codex_app_server_smoke.js` (initialize, account/read,
  thread/start, turn/start, and turn/interrupt observed against
  `codex-cli 0.154.0`). Live authenticated streaming, login completion, quota
  exhaustion, and a real approval request remain explicitly unverified because
  this environment has no account and cannot bind the login callback server.

**Task 0.2 — Vault and stack contract. Status: complete (2026-09-18).**

- Dependency: actual vault schema access; do not guess private fields if unavailable.
- Files: add `docs/vault-contract.md`; update architecture and this plan with selected stack and final paths.
- Work: inspect state, roadmap, note, and session conventions; define lossless mappings and revisions, metadata placement, transaction recovery, retention, and note identity. Choose a small Web/server stack supporting child processes and local filesystem operations. Record initial supported OS/browser and launcher prerequisites.
- Verification: round-trip redacted representative records including unknown fields; manually compare each view projection to its source. Review no-op, failed save, and conflicting external edit examples.
- Acceptance: exact mapping and write/recovery protocol are specified; fixture expectations preserve existing data. Any required migration is explicit and separately approved before execution.

  Evidence: [docs/vault-contract.md](vault-contract.md) records the inspected
  `/home/tahanan/learn/learning-vault` schema and conventions, the lossless
  repository and Git-compatible blob revision contract, operational metadata
  location/retention, Node.js 22 + built-in HTTP/SSE stack, and finalized
  Phase 1 boundaries. `node tests/vault_contract.test.js` passes 4/4 synthetic
  round-trip tests, and
  `node tests/vault_live_probe.js /home/tahanan/learn/learning-vault` reports
  9 topics, 8 indexed notes, 14 sessions, 8 topics with roadmaps, 6 projection
  markers with 1 stale marker reported, and an unchanged vault file snapshot.
  No vault files were modified or migrated.

## Phase 1 — Local Web shell and readable vault

**Task 1.1 — Four views and global topic context. Status: complete (2026-09-18).**

- Files: `web/`, `server/`, `runtime/vault/`, and `tests/fixtures/`; README startup instructions are verified below.
- Work: serve same-origin UI/API on loopback; configure one vault; render Study, Roadmap, Understanding, and Notes with global topic selection. Add global topic navigation, Markdown rendering, schema errors, empty states, and committed revisions. Understanding is inspectable only; no model integration or canonical writes yet.
- Automated verification: fixture projections, unknown-field preservation on reads, path containment, hostile Markdown, optional learner-state fields, note title/preview extraction, topic switching through the selector, rejected cross-origin mutations, correct topic isolation, and no canonical vault writes.
- Human verification: open a representative topic and navigate every view; verify empty/missing roadmap and unavailable Codex do not prevent browsing.
- Acceptance: all four views match source records without modifying the vault; topic selection is not a standalone page and Understanding is read-only.

  Evidence: `npm test` passes 17/17 tests, covering the fixture-backed views,
  unknown-field preservation, malformed state, missing roadmap, optional
  learner-state fields, note title/preview extraction, topic switching,
  topic isolation, path containment, hostile Markdown, no-write snapshots,
  and cross-origin mutation rejection. The server was started with
  `LATTICE_VAULT_ROOT=/home/tahanan/learn/learning-vault PORT=4317 npm start`
  and bound to `127.0.0.1:4317`; live probes returned ready health, nine topics,
  a roadmap-rich topic, and the sparse `software-development` topic with
  `roadmap: null`. The served HTML/CSS/ES-module assets returned successfully.
  A before/after snapshot of the authorized vault remained unchanged. Firefox
  154.0 was installed but headless screenshot capture crashed in this
  environment, so visual browser capture remains a tooling limitation; direct
  browser-facing HTTP and fixture integration checks passed. No canonical
  vault writes were made.

## Phase 2 — Reliable persistence and user editing

**Task 2.1 — Transactional repository. Status: pending.**

- Files: proposed `runtime/vault/`, `tests/persistence/`; update vault contract.
- Work: implement revision checks, writer lock, durable journal/staging, atomic per-file replacement, commit records, idempotency, and startup recovery. Keep metadata separate from domain content.
- Automated verification: inject failures before/after each file replacement and commit marker, replay operation IDs, simulate a second writer and external edit, and verify restart outcomes. Check that state+notes+checkpoint never produce false successful completion.
- Human verification: inspect recovered fixture files and an intentionally conflicted transaction.
- Acceptance: recovery proves the invariants in architecture before model-driven writes exist.

**Task 2.2 — Notes editor and read-only Understanding. Status: pending.**

- Files: proposed `web/`, `server/`, `runtime/vault/`, `tests/editing/`.
- Work: note creation/editing and draft/save/error/conflict states, origin records, validation, revision-aware saves, and view refresh events. Understanding remains inspectable and is corrected through Study/Reducer updates rather than direct learner-state editing. Preserve unknown fields and unsaved note drafts.
- Automated verification: note save/reload, invalid fields, duplicate save, stale revision, incoming update with open note draft, and user-correction provenance. Assert no Understanding mutation endpoint or direct `state.json` editor exists.
- Human verification: edit a note, restart, inspect saved data, and resolve a competing browser-tab edit; inspect Understanding and correct a learner judgment through a later Study interaction rather than a form.
- Acceptance: note edits survive restart, remain visible, and cannot be silently overwritten; Understanding remains read-only and learner-state corrections retain provenance.

## Phase 3 — Codex-backed Tutor and study control

**Task 3.1 — Read-only tutoring integration. Status: pending.**

- Files: proposed `runtime/codex/`, `runtime/study/`, `server/`, `web/`, `tests/codex/`.
- Work: implement the verified adapter, authentication status, context builder, thread/session mapping, streaming, cancellation, and explicit approval behavior. One in-flight turn; stable topic identity; disconnect/reconnect status recovery.
- Automated verification: protocol fixtures for auth failure, quota error, approval, child exit, duplicate/out-of-order events, cancellation, and browser reconnect. Assert model tools cannot mutate canonical learning files.
- Human verification: start a fresh thread on existing learner state; inspect coherent continuity and visible interruption.
- Acceptance: Tutor answers stream from current vault context. Until Phase 4 lands, label this a development-only read-only preview; never present it as a completed/saved Study Turn.

## Phase 4 — Complete the Study Runtime

**Task 4.1 — Reducer and commit barrier. Status: pending.**

- Files: proposed `runtime/study/`, `runtime/reducer/`, `tests/study/`; update V0 design with any clarified behavior.
- Work: isolated Reducer invocation, strict Study Update validation, evidence provenance, explicit no-op, note-worthiness and identity, checkpoint construction, revision recheck, and transactional finalization. Retry reduction/persistence without automatically repeating tutoring; bound retries and show failure.
- Automated verification: conservative evidence cases, malformed/foreign-topic updates, no-op checkpoint, note deduplication, manual edit during generation, partial persistence, cancellation race, and repeated completion events.
- Human verification: exercise understanding, uncertainty, correction, useful note, and trivial turns; inspect state and note changes.
- Acceptance: no path publishes successful turn completion before all required writes are durable; no fabricated mastery or stale overwrite.

**Task 4.2 — Visible learning changes and session continuity. Status: pending.**

- Files: proposed `web/`, `server/`, `runtime/study/`, `tests/e2e/`.
- Work: saving/saved/error feedback, links to changed notes and the updated Understanding projection, compact session history, resume/retry controls, and safe topic switching. Reconcile SSE gaps from authoritative snapshots.
- Automated verification: lost completion event, refresh during save, restart after commit, stale drafts, topic switching, and fresh Codex thread with existing state.
- Human verification: see a new note appear and learner-model change only after commit; edit the note and confirm the next turn uses it, while state corrections remain Study/Reducer-driven.
- Acceptance: a learner can tell what changed, whether it is saved, and what to do when it is not.

## Phase 5 — V0 acceptance and handoff

**Task 5.1 — Repeatable end-to-end evidence. Status: pending.**

- Files: proposed `tests/e2e/`; add `docs/v0-acceptance.md`; update README and this plan with actual results and known limitations.
- Work: run the complete [acceptance scenario](v0-design.md#v0-acceptance-scenario) against fixtures and an authorized local vault; verify clean startup/shutdown and no unintended file writes. Include offline Codex browsing/editing, authenticated live smoke, and deterministic fault tests.
- Automated verification: persistence/recovery, edit conflict, lifecycle, security boundary, and UI suites from prior phases, plus fresh-session continuity.
- Human verification: assess teaching continuity, usefulness of generated notes, clarity of save/conflict feedback, and usability of all views.
- Acceptance: record environment, dependency versions, commands, results, and remaining limits. V0 is complete only when the scenario is repeatable and product behavior is accepted.

## Scope control

Do not add cloud hosting, a desktop wrapper, alternate harnesses, API-key billing flows, automatic Git sync, automatic topic routing, vector search, or multi-agent orchestration to unblock these phases. See [non-goals](../INIT.md#non-goals). Resolve protocol/schema uncertainty through Phase 0 evidence and document any proposed scope change before implementing it.
