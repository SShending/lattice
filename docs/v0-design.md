# Lattice V0 Design

## 1. Problem

The current Learning Coach workflow runs inside a general-purpose agent environment. Updating learning state and writing learning notes are therefore optional behaviors that the model may omit while focusing on the visible conversation.

Lattice changes the responsibility boundary:

- Teaching remains model-driven.
- Learning-state interpretation is explicit.
- Persistence is enforced by the runtime.
- `state` and `notes` are not optional tool calls available to the Tutor.

The V0 design focuses on reliability before adding richer learning capabilities.

## 2. Design objective

V0 must support one persistent study topic across multiple turns and sessions.

A successful V0 should guarantee that:

1. The current learner state is loaded before each study turn.
2. The Tutor receives only the learner context needed for the active topic.
3. The Tutor can focus on teaching rather than storage responsibilities.
4. A separate Learning Reducer evaluates each completed turn.
5. The resulting state update is validated before persistence.
6. The authoritative topic state is written before the study turn is considered complete.
7. A durable note is written when the Reducer marks the turn as note-worthy.
8. Restarting Lattice restores the learner from the persisted topic state rather than reconstructing progress from chat history alone.

## 3. Architectural boundary

Lattice V0 does **not** reimplement an agent harness.

DeepSeek Harness provides the generic agent runtime responsibilities, including the default model/tool loop and session execution. Lattice adds the study-specific lifecycle around that runtime.

```text
                 Lattice
                    │
        ┌───────────┴───────────┐
        │                       │
 DeepSeek Harness        Lattice Study Runtime
 default agent loop             │
        │               ┌───────┴────────┐
        │               │                │
      Model       Context Loader   Learning Reducer
                                 + Persistence
                         │
                  local learning-vault
                         │
                        Git
                         │
                GitHub remote (optional)
```

DeepSeek Harness is the only harness in V0. OpenAI models may later be used through a model provider, but OpenAI Agents API is not part of the architecture.

## 4. Core domain objects

### Topic State

The durable representation of what the learner currently knows about one topic.

It should remain compatible with the existing `learning-vault/topics/<topic-id>/state.json` model rather than introducing a second source of truth.

Topic State should capture, at minimum:

- topic identity
- learning goal
- current focus
- established understanding / evidence
- uncertain or partially understood concepts
- known misconceptions when present
- next learning objective

### Study Turn

One learning interaction consisting of:

- learner message
- Tutor response

A Study Turn is conversational evidence, not yet durable learner state.

### Study Update

The structured interpretation produced by the Learning Reducer after a Study Turn.

It should describe only what changed because of the turn, such as:

- new evidence of understanding
- uncertainty
- misconception correction
- current-focus change
- next-step change
- note candidate

### Learning Note

A durable, reusable explanation or mental model worth keeping beyond the immediate turn.

A note is not a transcript summary. It should capture reusable understanding, distinctions, mistakes, or mental models that are likely to matter later.

## 5. Tutor and Reducer separation

V0 intentionally separates teaching from state management.

### Tutor responsibility

The Tutor answers one question:

> Given the learner's current state, what is the smallest useful next teaching interaction?

The Tutor may explain, ask a diagnostic question, correct a misconception, or connect the current concept to prior knowledge.

The Tutor does **not** directly write `state.json` or notes.

### Learning Reducer responsibility

The Reducer answers a different question:

> Given the previous Topic State and this Study Turn, what changed in the learner model?

Conceptually:

```text
previous Topic State + Study Turn → Study Update
```

The Reducer should be structured and conservative. It should prefer explicit evidence over assumptions such as treating “I understand” as mastery.

Useful evidence includes:

- correct explanation in the learner's own words
- correct application to a new case
- successful distinction between similar concepts
- correction of a previously observed misconception
- identification of a remaining uncertainty

## 6. Study-turn lifecycle

Every V0 turn follows the same lifecycle:

```text
1. User input
2. Resolve active topic
3. Load authoritative Topic State
4. Load only necessary related notes
5. Assemble learner context
6. Run Tutor through the DSH default agent loop
7. Produce Tutor response
8. Run Learning Reducer on previous state + completed Study Turn
9. Validate Study Update
10. Persist updated Topic State
11. Persist note if note-worthy
12. Append a lightweight session checkpoint if required by the vault model
13. Mark the study turn complete
```

The critical invariant is:

> **No successful Study Turn completes before learner-state persistence succeeds.**

This replaces prompt-level reminders such as “remember to update state” with a runtime guarantee.

## 7. Persistence model

V0 uses a **local checkout of `learning-vault`**.

The existing topic layout remains the source of truth:

```text
learning-vault/
└── topics/
    └── <topic-id>/
        ├── state.json
        ├── README.md
        ├── notes/
        └── sessions/
```

Lattice should access the vault through a small repository abstraction so storage remains replaceable later, but the V0 implementation target is only the local filesystem.

### Why local first

GitHub is not part of the per-turn study path because remote persistence would introduce unnecessary failure modes:

- network dependency
- connector permissions
- API latency
- branch conflicts
- duplicate writes
- commit coordination

The runtime responsibility ends when the local vault is durably updated.

Git remains useful for version history and synchronization, but Git/GitHub synchronization is a separate concern from learning correctness.

## 8. Why state and notes are not Tutor tools

V0 may internally have functions or services that save state and notes, but they are not exposed as optional model tools such as `write_note()` or `update_state()`.

The distinction is architectural:

```text
Tutor tool call
→ model may choose whether to call it
→ can be skipped

Runtime persistence operation
→ executed by lifecycle control
→ cannot be skipped on a successful turn
```

The model may decide **what** changed and **what** is worth noting. The runtime decides that valid updates are actually persisted.

## 9. Context policy

Lattice should not place the entire vault in model context.

For V0, the Tutor receives a compact learner context for the active topic, such as:

- topic and goal
- current focus
- established understanding / evidence
- current uncertainties
- known misconceptions
- next learning objective
- a small set of directly relevant durable notes

This context should be regenerated from the authoritative vault state each turn.

The DSH session history remains useful conversation context, but it is not the learner model.

## 10. Active topic policy

V0 supports **one active topic per study session**.

Topic selection is explicit. There is no automatic topic router in V0.

This avoids early ambiguity about whether a turn belongs to multiple overlapping topics. Cross-topic relationships can be added after the single-topic state transition is reliable.

## 11. Relationship between DSH session and Lattice state

These two concepts must remain separate.

### DSH session

Represents execution and conversation history: what happened during an agent session.

### Lattice learner state

Represents accumulated learning progress: what the learner currently understands, where uncertainty remains, and what should happen next.

A new DSH session should therefore be able to continue an existing Lattice topic by loading its persisted Topic State.

## 12. V0 components

Only five conceptual components are required:

1. **Study Runtime Plugin** — owns the study lifecycle and invariants.
2. **Tutor** — performs normal teaching interaction.
3. **Learning Reducer** — converts turns into structured Study Updates.
4. **Vault Repository** — reads and persists local learning-vault data.
5. **Study CLI / entry point** — starts a session with an explicit topic.

The exact DSH extension points should be chosen during implementation after validating the current DSH plugin/lifecycle APIs. V0 should keep this integration surface deliberately small because DSH is still evolving.

## 13. Explicit non-goals

V0 does not include:

- custom DSH agent loop
- OpenAI Agents API
- GitHub connector in the learning loop
- automatic push or commit
- multi-topic automatic routing
- cross-topic graph
- vector database
- semantic note retrieval infrastructure
- subagents
- planner agent
- note agent
- curator agent
- review scheduler
- spaced repetition
- automatic learning-strategy adaptation
- idea-vault integration
- UI beyond the minimum study entry point

These may become later versions only if the core state-transition model proves reliable.

## 14. V0 success criteria

V0 is complete when the following scenario works reliably:

1. Start Lattice on an existing `learning-vault` topic.
2. Lattice restores that topic's learner state.
3. Complete multiple teaching turns.
4. Each turn produces a validated state transition.
5. Relevant notes are persisted without relying on the Tutor to remember a write tool.
6. Stop the process.
7. Start a new session on the same topic.
8. Lattice continues from the persisted learner state without unnecessarily restarting or repeating mastered material.

The main metric is not feature count. It is **state continuity and persistence reliability**.
