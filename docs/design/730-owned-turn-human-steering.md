# Human follow-ups during an owned Codex turn (#730)

Status: protocol contract, current fallback regression coverage, and the first
V2 receipt compatibility implementation slice (#1155). Active
owned-turn injection is **not implemented** by this change. The current
runtime continues to queue authenticated Dashboard requests ahead of other
waiting work, without interrupting an already claimed turn. This contract
does not change the already released Node preview.142 / CLI preview.176.

## Current behavior and the missing boundary

`isInteractiveDashboardTask` requires a task/broadcast, `dashboard-chat`, a
valid `dreq_` id, and Hub-stamped `auth_origin=user`. A sender named `admin`,
a scheduler, a node, or a legacy row without that stamp is not this audience.
The dispatcher and bridge both use this explicit classification for waiting
priority. `steerIfExternalTurn` alone is not proof of that classification.

The existing external-human-turn path calls `turn/steer` and maps the shared
turn's final answer to accepted Dashboard rows. The owned-turn path instead
has one `PendingTurn`, joined by the original task's `clientUserMessageId`.
Reusing the external path would silently treat one final answer as independent
completion of every injected task. An owned task's final answer must retain
its original task identity. A Hub reply is also not proof that a requirement,
native acceptance, or production adoption has completed.

OpenAI's [app-server protocol](https://developers.openai.com/codex/app-server/)
requires the exact `expectedTurnId` for `turn/steer`; it fails without an
active turn, does not emit another `turn/started`, and cannot override model,
cwd, sandbox policy, or output schema. Protocol acceptance proves additional
input was accepted, not that the model answered that input. Existing external
steering compatibility remains outside this owned-turn implementation slice.

## Required owned-turn protocol

1. Only a Hub-authenticated Dashboard request may enter this new path. Require
   both the explicit audience flag and a locally owned, identity-confirmed,
   started turn. A response id alone, an in-flight `turn/start`, a Hub-validation
   claim, an orphaned network turn after reconnect, or an unknown successor
   cannot establish owned-turn identity. Use the existing waiting lanes in
   those cases. Do not reinterpret a generic steering option as authentication.
2. Recheck the follow-up's scoped, authoritative Hub pending state before
   admission; stale inbox delivery does not override cancellation or expiry.
   Preserve the original task's mapping, receipt, answer and cancellation
   authority. Each follow-up retains its own task/inbox ids, requesting scope,
   thread/turn binding, submission and acceptance evidence. Carry the original
   task id as a relationship, not as a replacement task identity. Persist that
   relationship in the existing durable receipt mechanism before claiming
   recoverability; do not add another private state source.
3. `turn/steer` transports the immutable follow-up identity and input to the
   existing thread with the exact active turn id. Never use `turn/start` on a
   busy thread as an implicit injection, change the thread/model/provider,
   answer approvals, reset context, or interrupt the original turn.
4. Record submission only when the exact body reaches transport. Record
   consumption only after a matching acceptance/identity proof. A wrong turn
   id, missing response, or unknown transport outcome is not consumption and
   is not a successful reply. A known rejection before acceptance can return
   to human-first waiting order. An ambiguous outcome must be reconciled by
   the immutable follow-up identity before resubmitting, to avoid duplicate
   execution. The body must not be replayed merely because a reply is missing.
5. The model may acknowledge or answer the follow-up using an explicit Hub
   reply scoped to its own id. This settles only that follow-up. Shared turn
   activity may indicate continuing work after acceptance, but cannot be
   presented as a separate model response or separate task completion.
6. At shared-turn completion, settle the original task with its original
   final answer/error. Do **not** broadcast that answer as successful completion
   of unresolved follow-ups. Recheck their exact Hub rows. Already replied,
   failed, cancelled, or expired rows need no new turn/reply. For an accepted
   follow-up still awaiting its own answer, schedule one answer-only continuation
   in the existing human lane, identifying what was already injected; do not
   rerun its action body. This continuation uses the same task id and its own
   normal reply path. Failed/interrupted shared turns remain visible and cannot
   become synthetic success; uncertainty requires a bounded diagnostic outcome.
7. Before acceptance, cancellation removes only that waiting follow-up. After
   acceptance, input cannot be retracted; stop waiting/delivery for that task
   according to its authoritative Hub state, without interrupting the shared
   turn or original task. An explicit user instruction to stop work is model
   input; cancellation of one Hub row is not permission to interrupt every row.
8. Preserve per-task finite waiting/response bounds, exact scoped activity,
   capacity retry limits and tool-side-effect guards. Original-task tool work
   must never authorize automatic replay of an accepted follow-up. Race handling
   must cover acceptance versus terminal, cancellation, successor rebinding and
   lost notifications. Reconnect without durable accepted identity uses the
   current fallback; never reconstruct authority from a sender alias or final
   answer text. A local lease/deadline is not the original Hub expiry.

## Incremental acceptance and delivery

### Implemented receipt compatibility slice (#1155)

The existing `NODE_DIR/codex-turn-receipts.json` now supports V1 original-task
rows together with V2 `owned_followup` rows. V2 keeps routing metadata, owner
task/turn relationship, a nonce and SHA256 of intended input; it does not copy
the input or result text. Its stages are `intent`, `accepted`, and `answering`.
Acceptance requires the persisted owner turn and nonce. An answer binding
requires the same thread, a distinct turn and the exact `anet:<follow-up id>`
user-message identity. Repeating that exact answer binding is idempotent.

Recovery retains intent/accepted rows without reading or delivering the owner's
terminal text. An answering row requires that exact user-message client id in
persisted app-server history before it may recover a final answer/error.
Missing or unsupported identity evidence stays unresolved; existing 48-hour
retention bounds still apply. V1 recovery remains compatible. The inspector
performs only history reads; it starts no turn and changes no Hub binding.

Unknown versioned rows/envelopes and malformed V2 rows cause recovery and all
ledger mutations (including direct `save`) to fail before rewriting the file.
The previous bytes are retained. The legacy runtime admission path also refuses
to run an action whose task id already has a V2 receipt, before importing the
runtime. This stops a partially supported adapter from replaying accepted work.
The error is scoped to that request; it does not interrupt the original turn.

This slice does **not** call `prepareFollowUp` from production admission or add
owned `turn/steer`. It does not yet reconcile explicit Hub replies or schedule
answer-only continuations. Those must be wired together in #1151. Hub runtime
evidence currently rejects a conflicting thread/turn binding; integration must
respect that immutable context and cannot invent activity for the old turn.
The legacy external-human steering policy is unchanged.

Upgrade/rollback: the same existing launcher, node directory and credential
sources apply; no new service, port/proxy mapping, environment variable or
private state file is introduced. This source slice creates no V2 row during
normal admission, and publishes no new runtime package on its own. Before a
later adapter writes V2, the authorized lifecycle owner must back up the existing
ledger and pending-reply state using the established private backup process.
Runtimes older than this codec may discard V2 rows: do not downgrade with V2
pending. Drain/resolve those rows using a compatible runtime in the normal
owner window before rollback. Never clear the ledger as a downgrade shortcut.
Git recreates code/schema/fixture, not those private receipts, Hub data or login
state; recovery needs authorized data backups or independent re-registration.
No complete node disaster-recovery claim follows from the fixture alone.

The first slice adds the contract and Docker tests across the real classifier,
bridge and runtime. They verify the current fallback: no owned injection,
original-only terminal attribution, independent waiting cancellation/deadline,
unconfirmed start/reconnect safety, and authoritative Hub removal. Production
mutations must make these assertions fail. They are not native adoption tests.

The implementation slice must add durable accepted-follow-up ownership,
explicit reply reconciliation and the answer-only continuation together. Its
Docker/CI gates must prove an accepted follow-up is injected exactly once,
does not inherit an original-only answer as its own success, and cancellation
cannot interrupt its owner. Test real WS wire ordering as well as runtime and
receipt integration before merging. If this slice requires a new receipt schema,
include migration, backward reads, crash recovery and the repository's recovery
instructions; a flag with an unsafe partial path is not an implementation.

After required checks pass, publish only exact merged `main` source with the
existing paired Node/CLI release gates. Never republish an immutable prior
version. Original-device acceptance requires a normal authorized owner window;
source, public artifacts, and actual adoption are separate gates. A planning
estimate starts when inputs and work are available; CI queues and native owner
windows do not supply a promised completion time.

## Deployment and recovery boundary

This slice changes docs/tests/CI only: no process startup, proxy/port mapping,
environment variable, credential source, production version, schema, or backup
state changes. Existing entrypoints and upgrade/rollback procedures remain in
the [agent-node guide](../../docs-site/docs/guide/agent-node.md). A clean checkout
recreates this fixture with its pinned Dockerfile and frozen dependency lock.
It does not restore Hub data, user registration, node credentials, or private
receipt state; those require existing authorized backups/re-registration.
Passing this fixture does not establish disaster recovery of a running node.
