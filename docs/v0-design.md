# Lattice V0 design

This is the product and study-loop contract for the [agreed direction](../INIT.md). Implementation boundaries are defined in [Architecture](architecture.md); tasks live in the [Development plan](development-plan.md).

## Responsibility boundary

Lattice turns learning bookkeeping into application control flow. Teaching and interpretation remain model-driven; validation, persistence, and completion are deterministic runtime responsibilities.

Two loops remain distinct:

- **Codex agent loop:** model → tools → observations → model → response.
- **Lattice study loop:** load learner context → Tutor → Learning Reducer → validate → persist → publish completion.

The Study Runtime lives in the Lattice Local Server, above Codex. It is not a Codex plugin or a replacement agent harness. Tutor and Reducer are sequential roles invoked through the same Codex adapter, not autonomous agents.

## Primary views

| View | Content | V0 interactions and acceptance |
| --- | --- | --- |
| Study | Active topic, conversation, current focus, turn phase, recent learning checkpoints | Send, cancel generation, retry failed finalization, start/resume a session. Stream the answer; show “Saving learning changes” until commit, then a summary with links to changed notes and the updated learner-model projection. |
| Topic selector | Existing topic titles, goals, focus, last recorded activity | Global top-bar context for selecting a topic shared by Study, Roadmap, Understanding, and Notes. |
| Roadmap | Existing topic milestones/order and current focus, linked to relevant state | Read-only navigation in V0. Missing roadmap data shows an empty state, not an invented plan or inferred mastery percentage. |
| Notes | Topic note list, rendered Markdown, source and revision details | Open, create, edit, preview, save, or discard an unsaved draft. Existing note deletion is deferred. Changes from a turn are visibly marked after commit. |
| Understanding | Goal, focus, evidence-backed understanding, uncertainty, misconceptions, next objective | Read-only learner model. Corrections are produced by Study interactions and validated Reducer updates, not direct state edits. |

Layout is flexible: a global active-topic selector, a central study area, and an Understanding panel are a useful starting point. Views share the active topic and committed revision, not separate copies of learning data.

All views distinguish loading, empty, invalid, disconnected, and ready states. Notes editors distinguish draft, saving, saved, failed, and conflict states; Understanding remains read-only. Preserve drafts while browsing or receiving updates; prompt before discarding them. A successful edit returns the new committed revision and updates relevant views. No change badge or “Saved” claim precedes persistence.

Browsing and local editing work without a Codex connection. A browser refresh reloads committed records; pending drafts must be explicitly warned about or recoverable, never represented as saved.

## Learning domain

**Topic State** is the durable learner model: topic identity, goal, current focus, understanding and supporting evidence, uncertainties, misconceptions, and next objective. These are conceptual fields to map onto the actual vault schema, not a replacement schema.

**Study Session** ties an explicit topic to a sequence of Lattice turns. It may reference a Codex thread, but a fresh Codex thread can continue learning from the vault. Session/thread identifiers are not topic identifiers.

**Study Turn** has a stable Lattice ID, session/topic ID, input, loaded revision, Tutor result, lifecycle status, and references to reduction/commit results. Codex execution completion only ends the Tutor phase.

**Study Update** is a validated proposal: turn ID, base revision, state changes, evidence references, and zero or more note candidates. Permit an explicit no-change result with a reason. It still requires a durable checkpoint recording that the turn was evaluated; do not manufacture progress to force a state mutation.

**Learning Note** preserves a reusable explanation, distinction, error correction, or mental model. It is not automatically a transcript summary. Notes have stable identity and provenance; edits preserve user text unless an explicit non-conflicting change is accepted.

**Checkpoint** links the turn and committed revision to its learning evidence and changes. Keep it compact; avoid duplicating full Codex transcripts in the vault.

## Tutor and Learning Reducer

Before each turn, load the authoritative topic state and a bounded set of relevant notes. Build fresh context including goal, focus, known understanding, uncertainties, misconceptions, and next objective. Never send the entire vault by default. Treat note content as learning data, not executable instructions.

The Tutor provides the smallest useful teaching interaction: explanation, diagnostic question, application, or correction. It has no direct write access to authoritative state, notes, or checkpoints.

The Reducer receives the frozen starting state, learner input, completed Tutor answer, and relevant evidence. It proposes changes conservatively. Valid evidence includes explanation in the learner's own words, application to a new case, distinctions, and correction of a misconception. Tutor statements and “I understand” alone do not establish mastery. Validate field types, topic identity, base revision, evidence references, and allowed note operations before applying anything.

A no-change update is legitimate. The runtime always evaluates note-worthiness and persists accepted notes, but does not require a new note every turn. A reducer-generated note update must not erase manual edits.

## Study-loop lifecycle

```text
accepted → loading → tutoring → reducing → validating → persisting → completed
                          ↘ awaiting approval ↗
pre-commit failures → failed / cancelled / interrupted
revision mismatch   → conflict
```

1. Accept an input with a stable idempotency key; resolve and freeze its topic/session.
2. Load a committed snapshot and its revision; block if that topic needs recovery.
3. Build bounded context and run the Tutor through Codex App Server.
4. Stream provisional answer events. Reflect any supported approval request explicitly.
5. After a successful Tutor result, run the separate Reducer.
6. Validate the Study Update; reject malformed, unrelated, or unsupported mutations.
7. Recheck revisions and persist state, accepted notes, and checkpoint as one recoverable logical transaction.
8. Publish the new revision, change summary, and `completed` only after durable commit.

No successful Study Turn completes before learner-state persistence succeeds. When state content is unchanged, checkpoint the validated no-op against the unchanged state revision. Required notes and checkpoints are part of the completion barrier, not best-effort work after it.

## Failure, cancellation, and resumption

| Situation | Required behavior |
| --- | --- |
| Tutor fails, quota is exhausted, or sign-in expires | Keep prior learning records; display the reason and any partial answer as incomplete. User can retry after resolving the cause. |
| Reducer output is invalid or generation fails | Keep the Tutor answer and mark finalization failed. Allow bounded explicit retry of reduction, not automatic re-teaching. |
| Persistence fails | Do not claim completion. Retain the validated update in recovery metadata and finish or recover it before further writes to that topic. |
| Revision changed after context load | Reject the stale proposal; preserve both the user's saved edit and draft. Reload and re-reduce against current state or let the user abandon the pending update. Never replay stale patches blindly. |
| Browser disconnects | Server retains ownership of the turn. Reconnection obtains its current status/revision without resubmitting the input. |
| User cancels before commit begins | Interrupt the active Codex work where applicable, mark the turn cancelled, and do not apply learning changes. A partial answer is not evidence of a completed interaction. |
| Cancellation arrives during commit | Finish/recover the transaction to a definite outcome; cancellation cannot imply a rollback of a completed save. |
| Server restarts | Recover journaled persistence first. Mark unfinished generation interrupted; never silently repeat model work. Resume the topic from its committed state, using a new Codex thread if necessary. |

V0 admits only one in-flight study turn. Topic browsing remains available; switching the study target waits for completion or cancellation/recovery. User saves may proceed during generation through revision checks, causing stale reduction to conflict; they serialize with commit/recovery. A topic with unresolved recovery cannot accept writes.

## V0 acceptance scenario

1. Open the local UI against an existing topic with non-empty state, notes, and a roadmap if present.
2. Inspect Study, Roadmap, Understanding, and Notes; missing optional records show honest empty states.
3. Start a fresh Codex-backed session and verify continuity from the vault.
4. Complete turns demonstrating understanding, uncertainty, a corrected misconception, a reusable note, and a trivial no-change exchange.
5. Observe streaming → saving → saved. Verify appropriate state/notes/checkpoints and inspect why each change occurred.
6. Edit a note in the UI. Reload and start another turn; the note remains authoritative and influences context. Learner-state corrections occur through a Study interaction and Reducer update, not a direct form.
7. Make an overlapping edit during generation. Verify conflict handling preserves the user's work.
8. Inject invalid reducer output, write failure, duplicate delivery, cancellation, browser reconnect, and process interruption during each commit stage. Verify no false completion, duplicate note, or silent overwrite.
9. Restart with a fresh Codex thread and verify learning continuity; do not unnecessarily reteach already demonstrated knowledge.
10. Disconnect Codex and verify local browsing/editing still works. Confirm no successful learning save depends on a Tutor choosing a write tool.

The exact [V0 scope and non-goals](../INIT.md#non-goals) remain binding throughout these checks.
