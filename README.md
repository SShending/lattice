# Lattice

Lattice is a local-first Web application for persistent learning: study a topic, see what changed, and edit the notes and learner state that guide the next interaction.

**A successful study turn is not complete until its validated learning changes have been durably saved.** A streamed answer alone is not completion.

## Agreed V0 direction

```text
Browser: Study · Topics · Roadmap · Notes · State
                       │ HTTP commands + SSE events
                       ▼
             Lattice Local Server
                Study Runtime
             /                 \
 Codex App Server          local learning-vault
 agent execution           learner state, notes,
 + authentication          roadmap, checkpoints
         │
    OpenAI models
```

Lattice owns the study loop: load context → Tutor → Learning Reducer → validate → persist → complete. Codex owns the generic model/tool loop. The local vault is the durable learning source of truth; Codex threads are conversation/execution history.

V0 is Web-first: a local server serves the browser UI and starts Codex App Server as a child process. A native desktop wrapper can come later. This replaces the earlier DSH-first runtime/plugin and CLI-first direction.

## What V0 will provide

- Explicit topic selection, with one active topic per study session.
- Study chat with streaming, cancellation, honest save status, and visible learning changes.
- Topics and Roadmap views backed by existing vault records.
- Readable, editable Notes and State with validation and conflict handling.
- Reliable state, note, and session-checkpoint persistence across restarts.
- Codex-managed ChatGPT sign-in; no Lattice-managed OpenAI credentials.

Local-first describes storage and application hosting, not offline inference: selected learner context is sent to Codex for model processing. Existing notes and state remain usable when Codex is unavailable. Account access and usage limits still apply.

## Repository status and reading order

**Documentation only; no application, launcher, installation command, or tests are implemented yet.**

1. [Product brief](INIT.md) — agreed intent, scope, and non-goals.
2. [V0 design](docs/v0-design.md) — views, learning domain, lifecycle, and acceptance.
3. [Architecture](docs/architecture.md) — ownership, persistence, editing, and authentication boundaries.
4. [Development plan](docs/development-plan.md) — ordered tasks and verification gates.
5. [Agent instructions](AGENTS.md) — durable constraints for contributors.

The existing private `learning-vault` repository remains separate from this application repository. Its actual schema and conventions must be inspected before implementation; example layouts in these docs are not migration instructions.
