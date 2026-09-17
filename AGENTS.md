# Lattice contributor instructions

## Product and architecture

- Read `INIT.md`, `docs/v0-design.md`, `docs/architecture.md`, and the active task in `docs/development-plan.md` before implementation.
- Build the agreed local-first Web application. Lattice owns the Study Runtime; Codex App Server owns agent execution and authentication; local learning-vault owns durable learning data.
- Keep browser UI, Study Runtime, Codex adapter, and vault repository boundaries separate. Do not embed storage writes in Tutor tools or replace Codex's model/tool loop.
- Keep scope within `INIT.md`. Do not restore the superseded DSH-first architecture or make `codex exec` the primary backend.

## Data and user experience

- A successful study turn requires validated, durable state, required notes, and checkpoint completion. Streaming text is not a saved turn.
- Use the same revision-aware persistence path for user edits and learning updates. Never silently overwrite concurrent edits or duplicate an update on retry.
- Preserve unknown vault fields and existing note/session conventions. Inspect actual vault schemas before writing or migrating data.
- Do not infer mastery merely from a Tutor explanation or learner assent. Preserve evidence provenance and label user corrections separately from demonstrated understanding.
- Make saving, unsaved drafts, conflicts, interrupted turns, and failures visible. Never discard an editor draft on an incoming update.
- Keep Codex credentials out of browser storage, logs, vault content, and application-managed credential files. Do not extract tokens or silently switch billing modes.

## Engineering

- Update the canonical docs when behavior or decisions change. Keep task status in the development plan, with at most one task in progress.
- Verify persistence recovery, duplicate delivery, cancellation, revision conflicts, and topic isolation with meaningful tests when implementing those behaviors.
- Use synthetic or redacted fixtures; do not commit private learner data, transcripts, or credentials.
- Do not claim an unimplemented launcher or dependency combination works. Record the tested Codex version and actual commands when available.

## Product validation

When asked whether a product, tool, feature, or project is worth building, investigate existing products and open-source implementations first. Compare coverage, maturity, maintenance burden, extensibility, and actual user requirements. Identify defensible differentiation before recommending a new standalone implementation; recommend reuse, contribution, differentiated implementation, or not building as appropriate. State incomplete or outdated evidence explicitly.
