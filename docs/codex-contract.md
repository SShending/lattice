# Codex App Server contract

Task 0.1 records the App Server contract observed on 2026-09-18. This is a
compatibility record for the Lattice adapter, not a copy of the generated
protocol. The installed executable is the source of truth for exact payload
schemas.

## Tested environment

- Codex executable: `codex-cli 0.154.0`
- Platform: Linux Mint 22.3.0, x86_64; App Server reports `platformFamily=unix`
  and `platformOs=linux`.
- Startup command: `codex app-server --stdio` (equivalent to
  `codex app-server --listen stdio://`).
- Transport: newline-delimited JSON-RPC 2.0 over child-process stdin/stdout.
- Schema command: `codex app-server generate-json-schema --out <directory>`.
  It writes v1 files and `codex_app_server_protocol.v2.schemas.json`; use the
  same installed binary when generating adapter types.
- Fixture command: `node tests/codex_protocol.test.js` (3 passing).
- Live child smoke (no credentials and no model call):
  `node tests/codex_app_server_smoke.js`.

The smoke scripts set `CODEX_HOME` to a temporary directory. They never print
or persist authentication material. A temporary `CODEX_HOME` is required in
this checkout because the normal home is not writable by the test sandbox.

## Initialization and notifications

The adapter starts one child and sends:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"lattice","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"initialized"}
```

`initialize` returned `userAgent`, `codexHome`, `platformFamily`, and
`platformOs`. The server may emit `configWarning` and
`remoteControl/status/changed` notifications before or after the response.
Unknown notifications must be retained as diagnostics and must not break the
reader loop. Responses and notifications can be interleaved.

## Authentication

`account/read` with `{}` returned:

```json
{"account":null,"requiresOpenaiAuth":true}
```

When an account is present, the account object is either the `chatgpt` or
`apiKey` variant in the generated schema. Lattice targets the ChatGPT variant;
it must report an API-key account as an unsupported billing mode rather than
silently switching backends.

`account/login/start` accepts the generated `chatgpt` variant and returns
`{type:"chatgpt", authUrl, loginId}` when the local login callback server can
start. In this environment the observed response was JSON-RPC error `-32603`
(`failed to start login server: Operation not permitted`), so opening the URL
and the completed-login notification were not live-tested. Lattice must expose
that error, keep drafts/recovery data, and allow retry. It must never receive,
store, or log a password, OAuth token, or the access-token variants marked
unstable in the schema.

Quota/entitlement/auth failures are model-phase failures. They do not mutate
the vault and cannot produce a successful Lattice turn. The adapter surfaces
the JSON-RPC error and any terminal turn error verbatim as redacted structured
diagnostics.

## Threads and turns

Start a thread with `thread/start`. The observed response includes a stable
thread ID, model/provider, `approvalPolicy`, `approvalsReviewer`, `sandbox`,
`activePermissionProfile`, `cwd`, and `runtimeWorkspaceRoots`. With no local
account, the installed server still created an `ephemeral:true` thread.

Resume an existing thread with `thread/resume` and `{threadId}`. The resume
response has the same thread/settings shape; use `excludeTurns:true` when a
client will hydrate paginated history separately. A thread ID is not a Lattice
topic ID. Lattice maps one Study Session to a Codex thread, but can create a
fresh ephemeral thread after restart and rebuild context from the vault.

Start a turn with `turn/start`:

```json
{"threadId":"<id>","input":[{"type":"text","text":"<message>"}],"outputSchema":<json-schema>}
```

`input` and `threadId` are required. `outputSchema` is optional and is the
protocol-supported mechanism for requesting structured final assistant output;
Lattice will use a strict reducer schema only for the Reducer phase and still
validate the returned JSON itself. Codex completion is not a learning commit.

The observed event sequence for an interrupted turn was:

`thread/status/changed(active)` -> `turn/started` -> `item/started` /
`item/completed` for the user message -> `thread/status/changed(idle)` ->
`turn/completed` with `turn.status:"interrupted"`.

Tutor text streams through `agent/message/delta` notifications (`threadId`,
`turnId`, `itemId`, `delta`). Other item/command/process notifications are
forwarded as typed events. A terminal successful turn uses `turn/completed`
with status `completed`; errors are represented by the turn's `error` field or
JSON-RPC errors. Lattice only publishes `completed` after its own reducer and
vault transaction have committed.

Interrupt with `turn/interrupt` and both `threadId` and `turnId`. The observed
response was `{}` and the terminal turn status was `interrupted`. Cancellation
before Lattice commit means no learning update; cancellation during commit is
resolved by the vault transaction and is not treated as rollback.

## Approvals and child failure

The generated v1 `ServerRequest` schema defines server-to-client approval
requests, including `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`, and
`item/tool/requestUserInput`. The client answers each request using its request
ID and the corresponding generated response schema. Lattice presents supported
approval requests explicitly and denies unsupported requests; it never
auto-approves a request that could write the canonical vault.

The adapter treats stdout EOF, non-zero child exit, malformed JSON, and unknown
request methods as explicit process/protocol failures. It fails the active
phase, retains the Tutor answer if one exists, and never reports a saved turn.

## Tutor/Reducer isolation and vault protection

Tutor and Reducer are sequential roles using the same adapter but separate
ephemeral Codex threads and separate prompts. The Reducer receives a frozen
starting snapshot, learner input, Tutor result, and selected evidence; it does
not inherit the Tutor thread transcript. No model-selected thread is allowed
to write canonical learning files.

For each role Lattice will:

1. Use a temporary role workspace as `cwd`, outside the configured vault.
2. Start the thread with the strictest available read-only permission profile
   (`sandbox:"read-only"`; observed default profile was `:read-only`, with
   `networkAccess:false`).
3. Send only bounded, serialized learning context; never expose a raw vault
   path or a write-capable persistence tool.
4. Deny every approval that requests write access, extra filesystem roots, or
   network access. Only the Vault Repository process may mutate canonical
   files.

The installed unauthenticated smoke could verify the returned read-only
permission profile, but could not execute a model tool call. Therefore the
strong claim that a live model cannot mutate a canonical vault remains an
explicit Phase 3 verification item. Read-only profile enforcement must be
re-tested with an authorized account before live Tutor integration.

## Structured Reducer output

`turn/start.outputSchema` is accepted by the current schema and is returned by
the server as part of the turn request. The adapter must parse the final
assistant item as JSON, validate it against Lattice's Study Update schema, and
reject prose, malformed JSON, foreign topic IDs, stale base revisions, and
unsupported mutations. A valid no-op is allowed. Structured output is a
proposal, never a direct vault write.

## Compatibility and open limits

- Exact method names and fields are version-sensitive; generate schemas from
  the pinned executable and fail fast on an incompatible version.
- Live ChatGPT login completion, successful authenticated model streaming,
  quota exhaustion, and a real approval request were not available in this
  sandbox. Their required handling is specified above but remains an
  authorized-account acceptance test.
- No credentials or authentication tokens were recorded.
