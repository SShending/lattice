# Lattice

Lattice is a local-first Web application for persistent learning: study a topic, see what changed, and keep the notes and learner model that guide the next interaction.

**A successful study turn is not complete until its validated learning changes have been durably saved.** A streamed answer alone is not completion.

## Agreed V0 direction

```text
Browser: Study · Roadmap · Understanding · Notes
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

- Explicit topic selection in the global top bar, with one active topic per study session.
- Study chat with streaming, cancellation, honest save status, and visible learning changes.
- Roadmap and Understanding views backed by existing vault records.
- Readable Notes with validation and conflict handling; Understanding is inspectable and read-only.
- Reliable state, note, and session-checkpoint persistence across restarts.
- Codex-managed ChatGPT sign-in; no Lattice-managed OpenAI credentials.

Local-first describes storage and application hosting, not offline inference: selected learner context is sent to Codex for model processing. Existing notes and state remain usable when Codex is unavailable. Account access and usage limits still apply.

## Repository status and reading order

Phase 1 Task 1.1 provides a read-only local Web shell over the existing vault.
It does not write canonical learning files and does not require Codex to browse
topics.

## Run the read-only shell

Requirements: Node.js 22.23.1 and a local checkout of
`SShending/learning-vault`.

```bash
LATTICE_VAULT_ROOT=/home/tahanan/learn/learning-vault npm start
```

Then open <http://127.0.0.1:4317>. The server binds to loopback only. Set
`PORT` to choose another loopback port. The shell exposes Study, Roadmap,
Understanding, and Notes views; the active topic is selected in the top bar.
Codex is intentionally unavailable until Phase 3; vault browsing remains
available.

Tests use only synthetic fixtures:

```bash
npm test
```

1. [Product brief](INIT.md) — agreed intent, scope, and non-goals.
2. [V0 design](docs/v0-design.md) — views, learning domain, lifecycle, and acceptance.
3. [Architecture](docs/architecture.md) — ownership, persistence, editing, and authentication boundaries.
4. [Development plan](docs/development-plan.md) — ordered tasks and verification gates.
5. [Agent instructions](AGENTS.md) — durable constraints for contributors.

The existing private `learning-vault` repository remains separate from this application repository. Its actual schema and conventions must be inspected before implementation; example layouts in these docs are not migration instructions.
