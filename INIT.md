# Lattice product brief

## Goal and first user

Help an individual learner using a local learning-vault and Codex continue studying across sessions, with visible, editable learning records that do not depend on the Tutor remembering to save them.

The current Learning Coach workflow can omit state or note updates while answering a question. Lattice moves that responsibility into an explicit Study Runtime, while retaining the useful teaching, evidence, and note-worthiness policies.

## Agreed direction

Build a local-first Web UI, a Lattice Local Server containing the Study Runtime, a Codex App Server adapter, and a local vault repository adapter. Start with the browser; consider a desktop wrapper only after V0. Codex supplies agent execution and authentication. Lattice supplies learning lifecycle and durable state transitions.

This supersedes DSH as the V0 harness, Lattice as a harness plugin, and a CLI as the primary study interface. A launcher may start the local server but is not the learning experience. `codex exec` is not the primary integration transport.

## Core workflows and success evidence

- Select an existing topic and resume from authoritative learner state.
- Study while seeing the distinction between an answer arriving and learning changes being saved.
- Inspect the active topic's Roadmap, Understanding, and Notes without digging through files.
- Edit notes and correct learner state through a Study interaction; see committed changes reflected in the next turn.
- Restart after successful saves or interrupted writes without losing accepted learning changes or duplicating notes.

The [V0 acceptance scenario](docs/v0-design.md#v0-acceptance-scenario) is the success standard. Reliability and inspectability take priority over the number of learning features.

## Scope and constraints

V0 serves one local user and one configured vault, with one active topic per study session and one in-flight study turn across the runtime. Users select topics explicitly. Browsing other topics does not retarget a running turn.

The four primary views are Study, Roadmap, Understanding, and Notes. The active topic is global workspace context selected in the top bar, not a standalone view. Notes remain directly editable in the later editing phase; Understanding is a read-only projection of how Lattice currently understands the learner. Learner-state corrections happen through a Study interaction and validated Reducer update, not by directly editing `state.json`. Roadmap is a read-only projection of existing roadmap records and current focus; a roadmap authoring system is deferred. Session checkpoints are available as lightweight history within Study.

Preserve existing vault data and unknown fields. Do not invent a competing learning store or silently migrate the vault. Keep credentials out of the browser and vault. Local storage does not imply offline model execution.

## Non-goals

- Cloud hosting, remote access, multi-user collaboration, accounts managed by Lattice, and cloud sync.
- Native desktop/mobile packaging, offline models, or a standalone CLI tutor.
- A custom agent loop, DSH integration, direct OpenAI API backend, or provider abstraction framework.
- Automatic Git commit/push, GitHub calls in the study loop, and automatic vault migration.
- Automatic topic routing, cross-topic graphs, vector retrieval, review scheduling, spaced repetition, and idea-vault integration.
- Subagents, planner/note/curator agents, autonomous background study, and wholesale Learning Coach feature migration.
- Topic creation/deletion and rich roadmap editing in V0; use existing vault topics.

## Decisions still requiring evidence

The architecture and product scope above are settled by the user. Task 0.1
verified the installed Codex App Server contract; Task 0.2 inspected the
private vault schema and selected Node.js 22 with built-in HTTP/SSE primitives,
lossless schema-preserving mappings, Git-compatible blob revisions, and
external operational metadata. The exact write implementation, checkpoint
template for newly-created records, supported browser matrix, and launcher
prerequisites remain later implementation decisions. See
[`docs/codex-contract.md`](docs/codex-contract.md) and
[`docs/vault-contract.md`](docs/vault-contract.md); no migration has been
authorized or performed.
