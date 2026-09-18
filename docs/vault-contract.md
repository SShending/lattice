# Learning Vault contract

Task 0.2 records the read-only inspection of the local
`SShending/learning-vault` repository performed on 2026-09-18. The vault is
private and authoritative. Lattice must treat this document as an adapter
contract, not as permission to migrate, normalize, regenerate, or otherwise
rewrite the vault during Phase 1.

## Observed vault

- Repository: `/home/tahanan/learn/learning-vault`, Git `main` at
  `880d7ee` (`Refresh AI for Manufacturing topic view`); working tree clean at
  inspection time.
- Manifest: `.learning-vault/vault.json`, `schemaVersion: 2`,
  `documentType: "vault-manifest"`, `vaultId: "github:SShending/learning-vault"`.
- Nine bound topics are listed by `topics[topicId].statePath`. The manifest
  also binds `.learning-vault/learning-strategy.json`,
  `.learning-vault/coach-state.json`, and `inbox/state.json`.
- Topic files observed: nine `state.json`, nine `README.md`, eight note Markdown
  files, and 14 session Markdown files. There are no topic roadmap files.
- Current state documents are schema v2 and have `documentType: "topic-state"`.
  All observed topics contain the common learner fields, but optional fields
  are genuinely absent in some records: `software-development` has no
  `roadmap`; several topics have no notes or sessions.
- Topic `README.md` files are projections. Some carry a source marker such as
  `source: topics/<id>/state.json` and a blob SHA; they never override bound
  state. Several projections were observed with no marker or a marker that is
  stale after later state commits; this is evidence that the projection is
  derived and may lag. README formats differ, so Lattice reads them as Markdown
  projections and does not parse them as a schema.
- Notes are Markdown without YAML frontmatter. State `notes` entries provide
  the machine identity and metadata (`id`, `path`, `updatedAt`, `kind`,
  `claimStatus`, `sources`). Existing note bodies contain headings and prose;
  Lattice must preserve the entire body byte-for-byte when not editing it.
- Sessions are Markdown checkpoint records. State `sessions` entries provide
  `id`, `path`, and `createdAt`. Existing records are intentionally
  privacy-minimized and have no uniform frontmatter. Some recent records end
  with `Update ID: ...` and `Base state revision: ...`; older records do not.
- State `appliedUpdates` is an object keyed by update ID. Observed entries have
  `updateId`, `baseRevision`, and `appliedAt`. This is the current Topic-local
  idempotency/audit index, not the migration history under
  `.learning-vault/migrations/`.

Representative read-only inspection covered a topic with roadmap, concepts,
notes, and sessions (`agent-foundations`), a topic with a session but no notes
(`ai-for-manufacturing`), a legacy topic with no roadmap (`software-development`),
and the manifest plus cross-topic files. The inspection did not modify the
vault and did not copy learner content into this repository.

## Lossless repository mapping

The Vault Repository exposes typed projections while retaining the original
document alongside every projection:

```text
VaultSnapshot
  vaultManifest: JsonDocument
  topic: TopicSnapshot
    state: JsonDocument                 # authoritative, complete JSON object
    readme: MarkdownDocument | absent   # derived projection
    notes: Map<noteId, MarkdownDocument + NoteIndexEntry>
    sessions: Map<sessionId, MarkdownDocument + SessionIndexEntry>
    topicRevision: DocumentRevision     # state.json blob fingerprint
    fileRevisions: Map<relativePath, DocumentRevision>
```

`JsonDocument` contains the parsed object, original UTF-8 bytes, relative path,
and revision. Unknown top-level fields, nested object fields, array members, and
entry metadata are retained in the complete object. A write may change only
explicitly supported fields and must merge them into the original object; it
must never reconstruct a smaller replacement schema. A missing optional field
stays absent unless the user or a later approved learning update explicitly
creates it.

The initial read-only views map as follows:

| Lattice view | Source of truth | Rules |
| --- | --- | --- |
| Topics | manifest topic binding + state `id/title/goal/currentFocus` | Enumerate manifest bindings; do not discover arbitrary directories as topics. |
| State | bound `topics/<id>/state.json` | Render supported fields and preserve every unknown field. |
| Roadmap | state `roadmap` when present | Missing roadmap is an honest empty state; never infer one from prose or concepts. |
| Notes | state `notes` index plus referenced Markdown | Validate paths remain under the topic; note body is authoritative Markdown. |
| Study/session history | state `sessions` index plus referenced Markdown | Render compact checkpoint metadata/body; do not treat a Codex transcript as a vault session. |

`README.md` is available as a human projection, but is not authoritative for
any mutation. Cross-topic strategy, coach state, and inbox are read-only
outside this contract's topic views; Phase 1 does not invent projections for
them.

## Identity and revisions

Identity is separate at each layer:

- `vaultId` comes from the manifest and must match the bound state.
- `topicId` is the manifest key and must equal state `id`; it is never a Codex
  thread ID or a filesystem path supplied by the browser.
- `noteId` is the state `notes` map key and entry `id`, with the referenced
  Markdown basename (without `.md`) required to match for existing notes.
- `sessionId` is the state `sessions` map key and entry `id`; the referenced
  Markdown filename is validated against the stored relative path.
- `turnId` is generated by Lattice for one study turn and is not written into
  Codex or vault identifiers unless included in a checkpoint body.
- `updateId` is a stable Lattice idempotency key. A repeated update returns the
  recorded outcome from `appliedUpdates`/operational metadata and never applies
  a second mutation.
- `operationId` identifies an HTTP/user edit or retry. It is distinct from
  `updateId` and `turnId` and is never used as a topic identity.

The vault has no explicit current revision field. Existing README source
markers and session `Base state revision` values were verified as Git blob
object IDs. Lattice therefore defines:

```text
blobRevision(bytes) = SHA-1("blob " + UTF-8-byte-length(bytes) + NUL + bytes)
topicRevision       = blobRevision(exact state.json bytes)
fileRevision(path)  = blobRevision(exact file bytes)
```

This is the Git-compatible SHA-1 content fingerprint, not a commit ID and not
permission to create commits. It can be computed without invoking Git. A
revision comparison covers exact bytes, so an external editor's formatting
change is a conflict even when parsed JSON is equivalent. For a multi-file
operation, the read set records every affected path and fingerprint.

Before any future write, the repository re-reads and compares all expected
fingerprints. A mismatch returns `conflict` with the latest snapshot and the
local proposed change; it never uses last-write-wins and never replays a stale
patch. Existing session base revisions and `appliedUpdates` entries are
evidence/provenance and must be preserved, not rewritten to the new revision.

The required outcomes are concrete:

- A validated no-op still creates a checkpoint/session record and an
  idempotency outcome, while leaving `state.json` and note bodies unchanged.
- A write failure before the logical commit marker leaves canonical files
  untouched and leaves a recoverable staged transaction under the external
  metadata directory; it is never reported as saved.
- If a user edits `state.json` or a note between snapshot and commit, the
  fingerprint mismatch returns `conflict`, preserves the user's file and the
  pending proposal, and requires an explicit reload/reduction or abandonment.

These cases are reviewed here as contract examples; failure injection and
recovery implementation belong to Phase 2.

## Future write shape and checkpoints

Task 0.2 does not implement writes. The planned repository write contract for
Phase 2/4 is:

1. Freeze a topic snapshot and its path fingerprints.
2. Validate a complete proposed state merge, note operation, and checkpoint
   before touching canonical files.
3. Stage after-images outside the vault, then commit `state.json`, any new or
   edited note Markdown, and the checkpoint/session index entry as one logical
   operation.
4. Record `origin` (`user` or `reducer`), `operationId`, `updateId`, base
   revision, target fingerprints, and outcome in operational metadata; add the
   existing `appliedUpdates` entry only as part of the canonical state update.
5. Publish success only after all required files and the durable commit marker
   are complete.

Existing Markdown files are never silently rewritten to add metadata. New
Lattice checkpoints use a compact Markdown session document and a new
`state.sessions` entry; the exact template is a Phase 4 implementation detail
and must follow the observed privacy-minimized conventions. A checkpoint is
required even for a validated no-op, but no mastery or state mutation is
manufactured to make it non-empty.

## Operational metadata and retention

Operational data must not pollute learning content, `.learning-vault`, or Git
history. For the initial supported Linux environment, store it outside the
vault under:

```text
$XDG_STATE_HOME/lattice/vaults/<sha256-normalized-vault-root>/
  writer.lock
  transactions/<operation-id>/manifest.json
  transactions/<operation-id>/staged/...
  operations/<operation-id>.json
  diagnostics/
```

When `XDG_STATE_HOME` is unset, use
`~/.local/state/lattice/vaults/<digest>/`. The digest prevents vault IDs or
paths from becoming directory names. This directory contains no Codex
credentials and no raw transcripts. It may contain the minimum reducer input,
validated proposal, path fingerprints, staged after-images, error, and outcome
needed for recovery. Browser drafts remain client-side/runtime state and are
not represented as saved vault data.

Pending transactions and unresolved conflicts are retained until resolved or
explicitly abandoned. Terminal operation records and diagnostics may be
garbage-collected after 30 days, capped at 1,000 records per vault, but only
when no pending transaction references them. Cleanup never removes canonical
learning files or `appliedUpdates` history.

## Stack and Phase 1 boundaries

V0 uses a deliberately small, dependency-light stack:

- Node.js 22.23.1, ECMAScript modules, and built-in `node:http`,
  `node:fs/promises`, `node:crypto`, `node:child_process`, and `node:test`.
- Vanilla browser HTML/CSS/ES modules served from the same loopback origin.
- HTTP JSON commands plus Server-Sent Events for browser updates. No WebSocket
  requirement in V0.
- No database, ORM, frontend framework, provider abstraction, or direct OpenAI
  API client. Codex remains the only model transport.
- Development host: Linux x86_64. Firefox 154.0 is installed for manual
  verification; browser compatibility beyond a current Firefox/Chromium class
  browser is not claimed until Phase 1 testing.

This stack choice is a design decision, not an implemented launcher claim. The
following source tree is final for Phase 1's readable-vault shell:

```text
server/
  main.js                 loopback server/process lifecycle
  http-api.js             same-origin command and snapshot routes
  sse.js                  event stream and replay boundary
runtime/vault/
  paths.js                manifest binding and path containment
  reader.js               read-only manifest/topic/document loading
  projections.js          five-view projections and empty/error states
  revisions.js            Git-compatible blob fingerprints
web/
  index.html              application shell
  app.js                  browser navigation/state rendering
  styles.css
tests/fixtures/vault/     synthetic schema fixtures only
tests/vault_contract.test.js
tests/vault_live_probe.js
```

Phase 1 does not create the production modules yet; it only fixes ownership
boundaries and names. `runtime/vault` is the only future module allowed to
read canonical vault files. `server` never embeds schema mapping, and `web`
never receives filesystem paths or credentials.

## Verification evidence and limits

The redacted/synthetic fixtures under `tests/fixtures/vault/` cover a complete
topic with unknown fields, a topic with no roadmap, a note, a session
checkpoint, and a manifest binding. `node tests/vault_contract.test.js`
verifies semantic JSON round-trip, byte-preserving Markdown, identity/path
rules, unknown-field preservation, and Git-compatible fixture revisions.

`node tests/vault_live_probe.js /home/tahanan/learn/learning-vault` performs a
read-only probe across all nine bound topics, checks representative optional
field combinations, reports matching/stale README source markers when present,
and confirms the complete vault file snapshot is unchanged before and after.
It prints only counts and schema facts, not learner content. Stale/missing
projection markers do not make the bound state invalid; the state file remains
authoritative.

The current repository does not expose an independent machine-readable schema
for Markdown session bodies, and some historical sessions lack update/base
revision markers. Lattice must preserve them as opaque Markdown and treat only
the state indexes and explicitly recognized markers as structured data. Exact
checkpoint template selection and transactional writes remain Phase 2/4 work.
