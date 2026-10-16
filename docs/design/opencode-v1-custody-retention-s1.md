# Versioned custody state and permission contract for V1 retention (S1 design, #1334)

Status: **design draft only**. This document defines a schema, a state machine and
a permission contract for a future V1 exact-instance retention/ custody protocol.
It is **not** a runtime implementation, **not** a custody proof, and it creates no
module that can only refuse. Nothing here changes runtime, marker, cleanup,
registry or startup paths. No native/original-machine run is performed or promised.

Lineage: this is the first design slice of #1269 (itself the prerequisite line of
#1238, per the five-layer structure — #1269 is **not** moved, and its contract /
native / main items remain **unfinished**). S2 (cleanup participation) and S3
(named handoff/release execution) are **not** dispatched. #1272 and #1239 are not
taken here. S1 is a design delivery time; it is not an ETA for the migration.

## 1. Verified source baseline (current `main`)

All symbols below were re-read from `main` at
`6ed5b6859fad31ab65449c79d98bfb22f119169c` on 2026-10-16; the older #1328
observation does not substitute for this reading.

- `agent-node/src/runtime/opencode-copresence/v1-safe-retention-request.ts` —
  a single observation with a digest; it refuses and states that byte-identical
  JSON reconstruction is not a durable recovery/custody entry.
- `agent-node/src/runtime/opencode-copresence/v1-owned-safe-topology.ts` —
  read-only topology observation; its own contract says current-process
  allocation and stable private files are observations, never final history or a
  custody lease, and lists native workspace retention/custody with cleanup and
  unknown-fault qualification among the things still required before commit.
- `agent-node/src/runtime/opencode-copresence/v1-migration-plan.ts` — refuses;
  it has an explicit "no intent or lease" refusal path.
- `agent-node/src/runtime/opencode-copresence/close-cleanup.ts` — `cleanupAfterExit`
  retries a caller-supplied identity/live-process predicate; the caller retains
  the root on timeout/unknown state.
- `agent-node/src/runtime/opencode-copresence/runtime.ts` — the two product call
  sites of that helper (close path and error path) share one cleanup closure.
- `agent-node/src/runtime/opencode-copresence/v1-borrowed-tui.ts` — a **different,
  cooperative, read-only** admission to an already-live node's lease
  (`schema`-versioned lock plus a scoped MCP credential). It is not custody of an
  owned runtime and cannot be reused as one; it is listed here only to bound the
  word "lease" in this document.
- No open custody/retention pull request exists on `main` at the time of writing.

Consequence: today no code can prove retention custody, writer exclusion, final
native history or a qualified release. Registration, idle, a clean shutdown flag
or a process-reference scan are **never** accepted as those things.

## 2. Identity binding (what a custody record is bound to)

A custody record binds **named participants** to **precise running instances**.
Nothing weaker may be written into it.

Required fields (names are indicative; the design owns the final spelling):

| Group | Fields | Why it is required |
|---|---|---|
| Schema | `schemaVersion` (integer, starts at 1), `recordId` (opaque), `createdAt` | Versioned; unknown higher versions must be refused rather than guessed |
| Source instance | `sourceNodeId`, `sourceAlias`, `sourceNetworkId` | Named participant, not "some node" |
| Process generation | `sourcePid`, `sourceStartTicks`, `sourceUid`, `sourceExePath` + exe attestation digest | A pid alone is reusable; ticks+exe pin the generation |
| Version capability | `sourceRuntimeVersion`, `sourceGeneration` (`v1`), capability set actually observed | Declared config version is not capability proof |
| Requested coordinate | `requestedDirectory` + `requestedRootInode`, `requestedConfigDigest` | Exact identity of the requested tree |
| Native coordinate | `nativeDirectory` + `nativeDataInode`, `nativeWorkspaceInode`, `nativeLaunchInode`, `nativeCheckpointDigest` | Exact identity of the native tree |
| Request / target | `requestId` (named request), `targetNodeId`/`targetAlias` (may be unset until handoff) | Handoff must be *named*, never implied |
| Revision / CAS | `revision` (monotonic), `prevRecordDigest`, `writerId` | Compare-and-set so two writers cannot both win |
| State | `state` (see §3), `stateEvidence` (digest of the independent evidence that justified the transition) | A state without evidence is not a state |

Explicitly **not** stored: credentials, tokens, passwords, provider keys, model
session content, message bodies, or any secret material. Digests and inode
numbers only. An empty `auth.json` is **not** evidence that a root holds no
secrets.

## 3. State machine

States (the design owns the names; the semantics below are the contract):

1. `observed` — read-only, no lease. Produced by the existing observations.
2. `prepare-requested` — a named prepare intent exists, bound to the identity
   group of §2. Not yet durable; no retention claim.
3. `prepared` — the prepare intent is durably recorded with a revision and CAS
   previous-digest. Still no retention claim.
4. `retain-pending` — the source instance exited **without** a qualified outcome
   (crash, unknown, unverifiable). The root is retained *pessimistically*: no
   consumer may adopt, clear or replay it.
5. `retained-ready` — the source instance produced a qualified outcome and the
   retention is durably recorded. Only now may a **named** handoff be attempted.
6. `handed-off` — a named target has adopted custody under a new revision, with
   the source record kept (both stores retained until release).
7. `released` — retention is explicitly released by the participant that holds
   it, with its own evidence. Release is the only transition that allows cleanup
   of the retained root.
8. `refused` — a terminal *decision* (not an error handler): the protocol could
   not establish the required evidence. Refusal retains both stores.

Transition table — every edge names its **executor**, the **independent evidence**
required before it may happen, and its **idempotency / concurrency / crash**
behaviour:

| From → To | Executor | Precondition (independent evidence) | Idempotency & concurrency | Crash handling |
|---|---|---|---|---|
| `observed` → `prepare-requested` | owning source instance | identity group of §2 fully read; requested+native inodes differ or are both absent per existing observation rules | replays produce the same digest; concurrent prepares conflict on CAS | nothing durable written ⇒ restart returns to `observed` |
| `prepare-requested` → `prepared` | owning source instance | durable write with `revision=1`, `prevRecordDigest=empty` | second writer loses CAS; identical replay is a no-op | torn write must be detected by digest; partial records are `refused`, not silently upgraded |
| `prepare-requested`/`prepared` → `retain-pending` | **any** participant that can observe the exit | the source instance stopped being the live generation (ticks/exe no longer match) **and** no qualified outcome exists | idempotent (state is already pessimistic) | this is the crash path: retain both stores, refuse adoption |
| `prepared` → `retained-ready` | owning source instance | the qualified outcome itself, plus a re-read of every inode in §2 that is *not* the same as the ones recorded at prepare time ⇒ refuse instead | duplicate outcomes collapse to one revision | if the re-read fails ⇒ `refused` |
| `retained-ready` → `handed-off` | named target, accepted by the source participant | target identity read independently; source record unchanged since the revision the target read; CAS on `revision+1` | exactly one successful CAS; a losing target must re-read | crash mid-handoff ⇒ both stores retained (`retain-pending` semantics) |
| `retained-ready`/`handed-off` → `released` | the participant that currently holds retention | explicit release intent naming the record and revision, plus its own evidence | idempotent per `(recordId, revision)` | crash before durable release ⇒ still retained (fail-safe direction) |
| any → `refused` | any participant | evidence missing, contradictory, mixed or of an unknown version | idempotent | never auto-clears, never replays |

Two rules hold across the table: **(a)** a transition that cannot be *proved*
becomes `refused`, never "best effort"; **(b)** unknown/mixed/older-version state
retains both stores and refuses adoption.

## 4. Permission contract

- **Ownership**: the custody record and any retained-root marker live in the
  source user's private state and are readable only by the owning uid. Cross-uid
  reads of the record are a refusal, not a merge.
- **Writers**: only the owning source instance may move `prepare-requested →
  prepared → retained-ready`; only a named target may request handoff; only the
  current holder may release. `writerId` plus CAS makes "two writers" detectable
  instead of silently last-write-wins.
- **Readers**: read-only observation may read the record but gains **no** lease,
  no writer exclusion and no history claim; it may not clear, replay or adopt.
- **Secrets**: this protocol never carries credentials. Retaining a database root
  must **not** disable credential persistence/cleanup, must not copy a real
  `auth.json` to a target, and must not treat an empty credential file as proof
  that the root has no secrets. Credential cleanup stays on its existing path and
  its own permissions; retention of a data root is a separate concern with a
  separate record.
- **Old or external sweepers**: an old launcher or an external sweeper that does
  not implement this protocol is **unknown** to us. We may not assume it is safe;
  the refusal contract in §6 is what protects the root until such participants
  are qualified.

## 5. Minimal source-owned API draft

Draft surface only — no runtime file is changed by this document, and none of
these functions may be implemented as a permanent `throw`:

```ts
// All functions are source-owned and bound to the identity group of §2.
type CustodyRevision = { recordId: string; revision: number; prevRecordDigest: string | null };

// Read-only. Never acquires a lease; returns refinement of the existing observation.
function readCustodyRecord(opts: { sourceNodeId: string; sourceAlias: string }):
  | { kind: "absent" }
  | { kind: "record"; state: CustodyState; revision: number; digest: string; bound: CustodyIdentity }
  | { kind: "unknown"; reason: "unreadable" | "schema-newer" | "mixed" };

// Durable prepare intent. Idempotent per (source instance generation, revision).
function requestRetentionPrepare(opts: { bound: CustodyIdentity }): Promise<CustodyRevision>;

// Qualified outcome of the owning source instance. Refuses if any bound inode changed.
function recordQualifiedOutcome(opts: { recordId: string; revision: number; evidence: OutcomeEvidence }):
  Promise<CustodyRevision>;

// Named handoff. CAS on revision; a losing target must re-read.
function handOffCustody(opts: { recordId: string; revision: number; target: CustodyTarget }):
  Promise<CustodyRevision>;

// Explicit release by the current holder. Idempotent per (recordId, revision).
function releaseCustody(opts: { recordId: string; revision: number; reason: ReleaseReason }):
  Promise<CustodyRevision>;

// What every consumer (close, catch/after-exit cleanup, stale sweep, restart) asks
// before touching a root. Returning "retain" is the default for anything unproven.
function custodyDisposition(opts: { root: string; participant: ParticipantIdentity }):
  "retain" | "released" | "unknown";
```

Wiring contract (draft): close and the error path ask `custodyDisposition` **before**
their existing cleanup predicate; `unknown` and `retain` both mean "keep the root".
No caller may flip this to "released" without a `released` state and its evidence.

## 6. Cleanup and refusal boundaries

Participation points, each with its refusal edge:

| Participant | May do | Must refuse when |
|---|---|---|
| `close()` path | read disposition; release only via `releaseCustody` | record is `retain-pending`, unknown, or newer schema |
| error/`catch` path | same as close; it shares the same cleanup closure | the identity check cannot be evaluated |
| after-exit cleanup (`cleanupAfterExit`) | defer while any of retain/unknown holds | its caller-supplied predicate is the *only* evidence available |
| stale sweeper (ours) | nothing about a retained root | the record exists in any state other than `released` |
| stale sweeper (external/old) | **unknown** | always — we cannot qualify it; retention must survive it |
| restart / old or mismatched version | read-only; refuse to adopt | version capability or generation does not match the record |

Refusal is a **decision with a reason code**, not a silent skip: reasons include
`no-record`, `schema-newer`, `generation-mismatch`, `inode-drift`,
`unqualified-exit`, `unknown-sweeper`, `mixed-state`.

## 7. Responsibility boundaries

- **#1272** owns the persistent marker/CAS/fsync implementation and the
  source-owned *preparation* mechanics. S1 defines the schema and contract those
  mechanics must satisfy; S1 does not implement them.
- **#1238** owns the intent journal and the all-launcher refusal gate for the
  auditable migration plan. S1 defines the custody states that gate depends on.
- **#1239** owns the final history / lossless restore gate. S1 makes no claim
  about final native history or restore; it only defines how a root is retained
  and named-released.
- **#1269** keeps its three items unfinished: this document does not complete the
  contract item, not the native item, not the main item.

## 8. Rejection contracts

| Case | Contract |
|---|---|
| Unsupported profile | refuse (`unsupported-profile`); never approximate with a supported one |
| Borrowed source (`v1-borrowed-*`) | refuse as custody: cooperative read-only lease is not custody |
| `unsafe`/headless source | refuse; safety posture is part of the identity |
| Older source without this protocol | refuse (`unqualified-participant`); retain |
| Mixed or unknown state | refuse (`mixed-state`); retain **both** stores; never auto-clear or replay |
| Target whose identity cannot be read independently | refuse; no implied handoff |

## 9. Minimal acceptance plan for the next slice (not executed here)

Positive (design-level, then isolated):
1. `observed → prepared` records a revision and digest, and a replay is a no-op.
2. qualified outcome ⇒ `retained-ready`; then a named handoff advances revision by
   exactly 1 and keeps the source record.
3. explicit release is the **only** path that makes cleanup permissible.

Negative (each must be witnessed red):
1. two concurrent prepares/handoffs ⇒ exactly one CAS wins, the loser re-reads.
2. inode/digest drift between prepare and outcome ⇒ `refused`, root retained.
3. crash after `prepare-requested` (before durable write) ⇒ no retention claim.
4. crash mid-handoff ⇒ both stores retained (`retain-pending`).
5. record with `schemaVersion+1` ⇒ `refused` (`schema-newer`).
6. an external/old sweeper touching the root ⇒ retention survives; no adoption.
7. empty `auth.json` on the root ⇒ credential cleanup is **still** performed on
   its own path (retention must not suppress it).

None of these runs natively or on an original machine in this slice.

## 10. What this document does not claim

It does not prove custody, writer exclusion, final native history, backup/restore
or cutover qualification; it does not implement markers, cleanup, registry or
startup changes; it does not release, migrate or publish anything; it does not
turn registration, idle, a clean-shutdown flag or a process-reference scan into a
lease. Those remain exactly as unproven as they are on `main` today.
