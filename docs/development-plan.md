# Lattice V0 Development Plan

This document turns the V0 design into a development sequence without committing to implementation details too early.

## Phase 0 — Validate assumptions

Before writing implementation code:

- confirm the current DeepSeek Harness plugin and lifecycle extension points suitable for:
  - injecting learner context before a Tutor turn
  - running persistence before a study turn is considered complete
- confirm the current `learning-vault` topic-state schema and note conventions
- decide how the active topic is supplied to a session
- define failure semantics for invalid reducer output or failed local persistence

Output of this phase:

- a small integration contract between Lattice and DSH
- a small integration contract between Lattice and `learning-vault`

## Phase 1 — Read-only continuity

Goal: prove that Lattice can start from the existing learner state without modifying it.

Required behavior:

1. Select one explicit topic.
2. Load that topic's authoritative `state.json` from a local `learning-vault` checkout.
3. Build a compact learner-context projection.
4. Inject that context into the Tutor turn.
5. Verify that the Tutor can continue from the recorded learning state instead of restarting the topic.

Do not write state or notes yet.

Exit condition:

- a fresh DSH session can resume an existing topic coherently from the local vault.

## Phase 2 — Structured Learning Reducer

Goal: separate teaching from state interpretation.

Required behavior:

1. Capture the previous Topic State.
2. Capture the completed Study Turn.
3. Run the Learning Reducer.
4. Produce a structured Study Update.
5. Validate the update against a strict schema.

The Reducer should initially focus on a very small set of changes:

- evidence of understanding
- uncertainty
- misconception changes
- current focus
- next learning objective
- optional note candidate

Exit condition:

- repeated test turns produce valid, conservative Study Updates without changing vault files.

## Phase 3 — Deterministic state persistence

Goal: solve the main Learning Coach reliability problem.

Required behavior:

1. Apply a validated Study Update to Topic State.
2. Persist the resulting authoritative `state.json` locally.
3. Treat failed persistence as a failed study turn rather than silently completing the turn.
4. Restart Lattice and verify that the persisted state is restored.

Persistence should be safe against partial writes. The exact atomic-write strategy is an implementation detail to decide in this phase.

Exit condition:

- learner-state updates survive process restarts with no dependency on the Tutor remembering an update action.

## Phase 4 — Durable learning notes

Goal: restore learning notes without reintroducing optional Tutor tool calls.

Required behavior:

1. Reducer may emit a note candidate.
2. Runtime validates the note candidate.
3. Note-worthy candidates are persisted under the active topic's `notes/` directory.
4. Trivial turns do not create noisy notes.
5. Existing notes are not duplicated unnecessarily.

Initial note-worthiness should favor reusable understanding over transcript summaries.

Exit condition:

- useful notes are generated and stored consistently while low-value turns remain state-only updates.

## Phase 5 — Session checkpoint

Goal: preserve a compact audit trail connecting study turns to learner-state evolution.

Required behavior should follow the existing `learning-vault/sessions/` conventions rather than introducing an unrelated session format.

This checkpoint is separate from the DSH session log:

- DSH session = agent execution history
- Lattice checkpoint = learning-state evidence/history

Exit condition:

- it is possible to inspect why the learner state changed without storing unnecessary full conversational transcripts in the vault.

## Phase 6 — End-to-end V0 validation

Run the minimum acceptance scenario:

1. Use an existing topic with non-empty learner state.
2. Start a new Lattice study session.
3. Verify correct context restoration.
4. Complete several turns containing:
   - one clear understanding signal
   - one uncertainty
   - one corrected misconception
   - one note-worthy explanation
   - one trivial turn that should not create a note
5. Stop Lattice.
6. Start a fresh session on the same topic.
7. Verify continuity from the persisted state.
8. Confirm no required state or note write depended on an LLM choosing to call a persistence tool.

V0 should not be declared complete until this scenario is repeatable.

## Deferred work

The following work should stay out of V0 even if it appears convenient during implementation:

- automatic Git commit/push
- GitHub connector
- automatic topic detection
- cross-topic relationships
- review scheduling
- spaced repetition
- learner-wide knowledge graph
- vector retrieval
- multi-agent orchestration
- custom DSH agent loop
- adaptive pedagogy experiments
- Learning Coach feature migration beyond the minimal Tutor/Reducer lifecycle
- idea-vault integration

## Design questions to resolve during implementation

These are intentionally left open until the relevant DSH and vault interfaces are inspected in code:

1. Which DSH lifecycle hook is the narrowest reliable place to inject learner context?
2. Which awaited lifecycle boundary can guarantee persistence before successful turn completion?
3. Should the Reducer use the same model as the Tutor in V0, or a smaller model with structured output?
4. What is the minimal backward-compatible mapping from Study Update to the current `learning-vault` state schema?
5. How should note deduplication work without adding semantic retrieval infrastructure?
6. What local-path configuration should identify the `learning-vault` checkout?
7. What exactly constitutes a failed Study Turn when the Tutor response succeeded but persistence failed?

These questions should be answered by the implementation, not hidden behind prompt instructions.
