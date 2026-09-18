# Local-first Web architecture

This document defines proposed implementation contracts, not existing functionality. The [V0 design](v0-design.md) owns learning behavior; the [development plan](development-plan.md) owns validation and delivery order.

## Process and ownership model

```text
Browser (local UI)
    │ same-origin HTTP commands / SSE events
    ▼
Lattice Local Server
    ├── Web API / UI assets
    ├── Study Runtime / Context Builder / Update Validator
    ├── Codex Adapter ── stdio JSON-RPC ── Codex App Server child
    │                                      └── agent loop / tools / model / auth
    └── Vault Repository ── local learning-vault
                             state / notes / roadmap / checkpoints
```

| Component | Owns | Must not own |
| --- | --- | --- |
| Browser | Navigation, local editor drafts, rendering, explicit commands | Credentials, canonical learner state, direct filesystem/process access |
| Local Server | Loopback hosting, command validation, events, process lifecycle | Generic model/tool execution |
| Study Runtime | Topic/session identity, context snapshots, Tutor/Reducer sequence, completion barrier | Codex's internal agent loop |
| Codex Adapter | Child process, protocol/version compatibility, thread/turn mapping, events, approvals, interruptions | Vault writes or mastery decisions |
| Vault Repository | Schema mapping, revision checks, validation, journaled commits, recovery | Model calls or UI state |

Use a small typed interface between these responsibilities. Avoid a general plugin framework or provider framework in V0. Framework/language and final source paths are Phase 0 choices; HTTP plus SSE and a child-process adapter define boundaries without requiring a particular framework.

The planned launcher starts one local server, acquires the vault writer lock, recovers pending writes, starts/connects its Codex child, and opens a loopback URL. Shutdown stops new turns, interrupts generation, completes or journals pending commits, and closes the owned child. No executable launcher exists yet.

## Browser contract

Commands cover listing/selecting topics, loading topic views, starting/resuming a study session, submitting/cancelling a turn, retrying finalization, and saving notes/state. Mutation requests carry stable operation IDs and expected revisions. Responses return operation status and committed revision or an explicit validation/conflict error.

Events carry an event ID/sequence, session/topic/turn identity, phase, and relevant revision. The UI ignores duplicate events and events for unrelated views. SSE reconnect requests missed events when retained; otherwise it fetches a fresh authoritative snapshot and active-turn status. Event replay is a UI convenience, never the durability authority.

Use domain events such as answer delta, phase changed, approval requested, learning committed, and turn failed. These are proposed Lattice event names, not claims about Codex protocol names. API writes validate resource IDs and fields on the server; a browser-provided path is never trusted.

## Codex integration and authentication boundary

The official [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes a bidirectional JSON-RPC interface, default stdio transport, initialization, threads/turns, streaming events, approvals, and account operations. V0 uses a locally spawned `codex app-server` child over stdio. Pin and verify a supported installed version; do not parse human CLI output.

Adapter validation must cover initialize/initialized, thread start/resume, turn start/interruption, terminal outcomes, server requests, and account status. Tutor and Reducer use isolated execution context so reduction instructions do not pollute tutoring; the exact thread strategy is validated in Phase 0. Protocol completion ends a model phase, not a Lattice study turn.

Codex manages sign-in and credential refresh. Lattice reads account status and directs the learner through the supported Codex ChatGPT login flow. Use existing Codex-managed authentication where available; otherwise expose its login URL/status. Do not extract credentials, copy auth files, collect passwords, manage OAuth tokens, or use externally supplied ChatGPT tokens in V0.

[Official authentication guidance](https://learn.chatgpt.com/docs/auth) distinguishes ChatGPT subscription access from API-key usage-based access. V0 targets ChatGPT sign-in, subject to account entitlement and usage limits; it does not promise unlimited access. Detect and explain an API-key configuration rather than silently switching billing modes or falling back to direct API calls. Both Tutor and Reducer consume backend usage. Authentication failure must preserve unsaved/recoverable work.

These upstream facts were checked on 2026-09-17. The installed runtime contract
was subsequently verified against `codex-cli 0.154.0` on 2026-09-18; see
[Codex contract](codex-contract.md) for exact commands, payloads, observed
events, and limitations. Exact method payloads and supported capabilities
remain version-sensitive; the adapter must generate or validate against the
pinned executable rather than treating these docs as generated protocol types.

## Local security and data boundary

Bind only to loopback. Validate Host/Origin, reject cross-origin mutation requests, and protect local commands against CSRF/DNS-rebinding. Do not expose a raw Codex RPC proxy or a public unauthenticated local-file API. Serve UI and API from the same local origin.

Only the Vault Repository may mutate canonical learning files. Tutor/Reducer execution must use a read-only or isolated workspace without vault write permissions; disabling named persistence tools alone is insufficient when shell/file tools exist. Verify the selected Codex permission profile enforces this. Unsupported approval requests are denied explicitly, never silently approved. If optional tools are enabled, surface supported requests in Study and keep canonical vault writes prohibited.

Resolve resource paths under the configured vault root, reject traversal and escaping symlinks, and sanitize rendered Markdown/HTML. Keep account secrets and sensitive protocol payloads out of browser storage, events, and logs. Send only selected learning context to Codex; never claim model execution stays on device.

## Vault compatibility and identity

The existing design expects a topic layout resembling:

```text
learning-vault/topics/<topic-id>/
    state.json
    README.md
    notes/
    sessions/
```

This layout is illustrative. Actual state fields, roadmap placement, note frontmatter, session conventions, and extension rules must be inspected against the user's vault before implementation. Do not infer that roadmap requires a new file, or overwrite topic README content to create one. Preserve unknown fields and unrelated files; use explicit backed-up migrations only if later authorized.

The local vault remains authoritative. Browser caches, Codex history, and any search/index projections are disposable. Operational transaction metadata is separate from learning content but must be stored locally with a documented recovery location. No database, vector store, or GitHub call is required in the study path. Git commits/pushes are user-managed and are not part of successful persistence.

## Persistence and edit invariants

1. Every command has a stable operation/turn ID; repeated delivery returns the previous outcome instead of applying twice.
2. Load a committed snapshot with a revision covering all affected state and notes. Check it again immediately before writing. Content fingerprints also detect external editor changes between loads.
3. Serialize commits with one writer lock per vault. A second Lattice writer must refuse the vault. External editors do not honor this lock: never claim arbitrary simultaneous external writes are safe; ask users to pause them during saves and surface detected conflicts.
4. Validate a complete update before any canonical mutation. Store a durable write-ahead transaction record containing base/target fingerprints and staged after-images for state, accepted notes, and checkpoint.
5. Persist each file using same-filesystem staged writes and atomic replacement with appropriate durability flushing. Individual atomic renames do **not** make a multi-file transaction atomic.
6. Mark the logical transaction committed only after every required target is durable. Lattice readers must wait during commit/recovery so they never present a mixed snapshot as committed.
7. On startup or write failure, inspect pending transactions before serving writable topic views. Idempotently roll forward verified staged targets. If an external edit conflicts with base/target fingerprints, stop recovery for that topic and preserve all versions for resolution; do not clobber it.
8. Publish “Saved”/`completed` only after the commit record is durable. A crash after commit but before the event is resolved by reloading the recorded result.
9. A validated no-op checkpoints evaluation against the existing state revision. Missing or invalid state is not a no-op.
10. Note identity and update IDs prevent duplicate creation on retries. A note failure also prevents successful turn completion.

Manual notes/state saves use this same path with `origin=user`, expected revisions, and a compact change record. User assertions remain distinguishable from assessed evidence. Rejected edits leave canonical files intact and retain the browser draft. On conflict show the latest content and the draft; require explicit reconciliation or reload rather than last-write-wins.

Learning proposals are automatically persisted only when valid and non-conflicting. Keep stable reducer inputs and validated proposals as needed for recovery; minimize retained transcripts. Define cleanup/retention in Phase 0 so pending transactions are never removed prematurely. Ordinary filesystem viewers may observe intermediate files during recovery; the consistency guarantee applies to Lattice readers and completed operations, not arbitrary outside readers.
