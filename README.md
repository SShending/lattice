# Lattice

Lattice is a persistent study agent built around a learner state rather than a generic chat history.

Its core goal is simple: **a study turn is not complete until the learner state has been updated and persisted.**

Lattice is being designed to replace the current Learning Coach plugin workflow, where learning-state and note updates can be skipped because they are optional behaviors inside a general-purpose agent runtime.

## V0 goal

V0 should prove one thing reliably:

> A learner can study one topic across many turns and sessions without losing learning progress, while useful notes are persisted deterministically.

V0 will use:

- **DeepSeek Harness (DSH)** as the agent harness and default agent loop.
- A small **Lattice study-runtime plugin** for the learning lifecycle.
- A local checkout of **learning-vault** as the source of truth for learner state and durable notes.
- A two-stage **Tutor + Learning Reducer** design.

V0 will not introduce a custom agent loop, GitHub connector in the study path, vector database, subagents, topic routing, review scheduling, or automatic Git synchronization.

## Core model

Lattice treats learning as a state transition:

```text
TopicState(t)
    +
StudyTurn(t)
    ↓
Learning Reducer
    ↓
StudyUpdate
    ↓
TopicState(t+1)
```

The Tutor teaches. The Reducer interprets what the turn means for the learner state. The runtime guarantees persistence.

## Repository status

The project is currently in **V0 design / pre-development**. No implementation has started yet.

See:

- [V0 Design](docs/v0-design.md)
- [Development Plan](docs/development-plan.md)

## Related repository

Lattice is designed around the existing private `learning-vault` repository, whose topic-level state, notes, and session records remain the learning data source of truth.
