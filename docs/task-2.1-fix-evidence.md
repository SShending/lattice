# Task 2.1 Acceptance Fix Evidence

This document records remediation evidence for the independent review in
[`task-2.1-acceptance.md`](task-2.1-acceptance.md). That report remains the
original review baseline and is intentionally unchanged.

## Remediated findings

| Finding | Fix | Regression evidence |
| --- | --- | --- |
| Mixed snapshots and concurrent commits | A single FIFO lifecycle queue serializes snapshots, commits, recovery, and close. A failed commit recovers before returning and blocks normal reads/writes while an unresolved transaction remains. | `failed partial transaction blocks snapshots...`; `commits form a strict FIFO queue...`; `three-file transaction recovers...` |
| Crash lock and path aliases | Linux `flock --exclusive --nonblock` owns the lock through the helper process lifetime. The vault root is resolved with `realpath`, so symlink aliases share one identity. | `SIGKILL releases the writer lock...`; `a symlink alias...` |
| Commit marker replay | `commit.json` stores the complete stable result. Recovery reconstructs operation records and update-ID replay from the marker; committed transactions are never re-applied or rolled back. | `commit marker recovery rebuilds...`; `after-commit-marker` recovery |
| Missing/null expected revisions | Every target requires an explicit expected revision. A 40-character Git blob revision means existing content; `null` means the target must not exist. Missing and malformed values are request errors. | `every write target requires...` |
| Symlink write escape | Every existing path component is checked with `lstat` before staging/replacement; topic and target resolution use canonical roots. | `write targets reject symlink parent escapes` |
| No-op and required files | Empty transactions are rejected. Reducer transactions require a new checkpoint, state after-image, explicit expected revisions, and all newly indexed note/session files in the same transaction. | `learning no-op requires...`; normal and three-file transactions |

## Commands and results

On Linux x86_64 with Node.js 22:

```text
node --test tests/task_2_1_acceptance.test.mjs   # 16/16 passing
node --test tests/persistence.test.mjs            # 15/15 passing
```

The complete suite is run separately after these focused suites. All fault
injection uses copied synthetic vaults under temporary directories. The real
learning-vault is never used for destructive or failure testing.

The complete Linux suite (`npm test`, with loopback access for the existing
HTTP tests) passes 52/52 tests.

## Recovery contract clarification

A transaction with a complete manifest is pending and must be rolled forward
or retained as a conflict before normal reads/writes resume. A crash during the
initial staging journal, before the complete manifest exists, cannot have
modified canonical files; startup marks it `abandoned` with `saved: false` and
retains its metadata for diagnostics. A commit marker is irrevocable and
always reconstructs a complete committed operation result.

## Remaining limitations

`flock` is the supported lock implementation for the current Linux target. A
different operating system requires an equivalent process-lifetime advisory
lock implementation before being claimed as supported. Filesystem power-loss
durability is verified through flushed writes, directory syncs, deterministic
failure injection, and process termination; actual sudden power removal is not
reproducibly testable in this environment.

## Second-round P1 fixes (2026-09-20)

Normalized transaction paths must remain inside the selected topic, and duplicate resolved targets are rejected before staging. The `../legacy-topic/...` probe is rejected as an invalid request; regression assertions verify that both the selected state and the other topic remain unchanged.

After canonical replacement begins, recovery verifies every staged after-image and captured original. A damaged staged file is retained as evidence, marks the transaction recovery-required, and blocks snapshots and later writes until reliable recovery or explicit resolution. Pure request validation failures remain non-mutating and do not enter this barrier.

Additional focused coverage: `node --test tests/task_2_1_acceptance.test.mjs tests/persistence.test.mjs` passes 31/31 on Linux x86_64 with Node.js 22. The complete `npm test` suite is run after these focused tests.
