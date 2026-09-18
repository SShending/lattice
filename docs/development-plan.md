# Lattice V0 development plan

## Current position

The repository contains documentation only. The user has agreed to [the V0 direction](../INIT.md); no implementation phase is complete or in progress. This plan replaces the former DSH integration sequence. Keep at most one task in progress and attach acceptance evidence before marking it complete.

Source paths below are proposed module locations, to finalize in Phase 0. No files listed as implementation targets have been created. Each phase depends on the preceding phase unless noted. Use synthetic or redacted vault fixtures.

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

**Task 0.2 — Vault and stack contract. Status: pending.**

- Dependency: actual vault schema access; do not guess private fields if unavailable.
- Files: add `docs/vault-contract.md`; update architecture and this plan with selected stack and final paths.
- Work: inspect state, roadmap, note, and session conventions; define lossless mappings and revisions, metadata placement, transaction recovery, retention, and note identity. Choose a small Web/server stack supporting child processes and local filesystem operations. Record initial supported OS/browser and launcher prerequisites.
- Verification: round-trip redacted representative records including unknown fields; manually compare each view projection to its source. Review no-op, failed save, and conflicting external edit examples.
- Acceptance: exact mapping and write/recovery protocol are specified; fixture expectations preserve existing data. Any required migration is explicit and separately approved before execution.

## Phase 1 — Local Web shell and readable vault

**Task 1.1 — Five views. Status: pending.**

- Files: proposed `web/`, `server/`, `runtime/vault/`, `tests/fixtures/`; update README with real startup instructions only once verified.
- Work: serve same-origin UI/API on loopback; configure one vault; render Study shell, Topics, Roadmap, Notes, and State. Add explicit topic navigation, Markdown rendering, schema errors, empty states, and committed revisions. No model integration or canonical writes yet.
- Automated verification: fixture projections, unknown-field preservation on reads, path containment, hostile Markdown, rejected cross-origin mutations, correct topic isolation.
- Human verification: open a representative topic and navigate every view; verify empty/missing roadmap and unavailable Codex do not prevent browsing.
- Acceptance: all five views match source records without modifying the vault.

## Phase 2 — Reliable persistence and user editing

**Task 2.1 — Transactional repository. Status: pending.**

- Files: proposed `runtime/vault/`, `tests/persistence/`; update vault contract.
- Work: implement revision checks, writer lock, durable journal/staging, atomic per-file replacement, commit records, idempotency, and startup recovery. Keep metadata separate from domain content.
- Automated verification: inject failures before/after each file replacement and commit marker, replay operation IDs, simulate a second writer and external edit, and verify restart outcomes. Check that state+notes+checkpoint never produce false successful completion.
- Human verification: inspect recovered fixture files and an intentionally conflicted transaction.
- Acceptance: recovery proves the invariants in architecture before model-driven writes exist.

**Task 2.2 — Notes and State editors. Status: pending.**

- Files: proposed `web/`, `server/`, `runtime/vault/`, `tests/editing/`.
- Work: note creation/editing and supported State forms; draft/save/error/conflict states, origin records, validation, revision-aware saves, and view refresh events. Preserve unknown fields and unsaved drafts.
- Automated verification: save/reload, invalid fields, duplicate save, stale revision, incoming update with open draft, and user-correction provenance.
- Human verification: edit note/state, restart, inspect saved data, and resolve a competing browser-tab edit.
- Acceptance: edits survive restart, remain visible, and cannot be silently overwritten.

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
- Work: saving/saved/error feedback, links to changed notes/state, compact session history, resume/retry controls, and safe topic switching. Reconcile SSE gaps from authoritative snapshots.
- Automated verification: lost completion event, refresh during save, restart after commit, stale drafts, topic switching, and fresh Codex thread with existing state.
- Human verification: see a new note appear and state change only after commit; edit each and confirm the next turn uses the edits.
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
