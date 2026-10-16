# Versioned custody state, CAS authority and cleanup contract for V1 retention (S1 design, #1334)

Status: **design draft only** (revision 2, after review of head `4214d1c8`). This
document defines a schema, a cleanup decision, a state machine, a commit authority
and a permission contract for a future V1 exact-instance retention/custody
protocol. It is **not** a runtime implementation and **not** a custody proof.
Nothing here changes runtime, marker, cleanup, registry or startup paths.

Lineage: first design slice of #1269 (prerequisite line of #1238; #1269 is **not**
moved and its contract/native/main items remain **unfinished**). S2 (cleanup
participation) and S3 (named handoff/release execution) are **not** dispatched;
#1272 and #1239 are not taken here. Design delivery time, not a migration ETA.

## 1. Verified source baseline (current `main`)

Re-read from `main` at `6ed5b6859fad31ab65449c79d98bfb22f119169c` on 2026-10-16 (the
older #1328 observation does not substitute for this reading):

- `v1-safe-retention-request.ts` — one observation with a digest; refuses; states
  that byte-identical JSON reconstruction is not a durable recovery/custody entry.
- `v1-owned-safe-topology.ts` — read-only topology observation; its own contract
  says current-process allocation and stable private files are observations, never
  final history or a custody lease.
- `v1-migration-plan.ts` — refuses; has an explicit no-intent-or-lease refusal path.
- `close-cleanup.ts` — `cleanupAfterExit` retries a caller-supplied identity /
  live-process predicate; the caller retains the root on timeout/unknown.
- `runtime.ts` — the two product call sites of that helper (close path, error path)
  share one cleanup closure.
- `v1-borrowed-tui.ts` — a different, cooperative, read-only admission to an
  already-live node's lease; not custody of an owned runtime (listed only to bound
  the word "lease").
- No open custody/retention pull request exists on `main` at writing time.

Consequence: no code can today prove retention custody, writer exclusion, final
native history or a qualified release. Registration, idle, a clean-shutdown flag
or a process-reference scan are **never** accepted as those things.

## 2. Identity binding (what a custody record is bound to)

A record binds **named participants** to **precise running instances**. Nothing
weaker may be written into it.

| Group | Fields | Why required |
|---|---|---|
| Schema | `schemaVersion` (int, from 1), `recordId`, `createdAt` | Versioned; a higher version is refused, never guessed |
| Source coordinator | `coordinatorNodeId`, `coordinatorAlias`, `coordinatorNetworkId` | Named participant, not "some node" |
| **Coordinator generation** | `coordinatorPid`, `coordinatorStartTicks`, `coordinatorUid`, `coordinatorExeDigest` | Binds *who may durably write*; a pid alone is reusable |
| **Native generation** | `nativePid`, `nativeStartTicks`, `nativeUid`, `nativeExeDigest`, `nativeRuntimeVersion` | The server/TUI child is a **different** process generation from the coordinator; keeping them apart is what makes "the coordinator exited" ≠ "a stale process may now write an outcome" |
| Capability | `sourceGeneration` (`v1`), observed capability set | Declared config version is not capability proof |
| Requested coordinate | `requestedDirectory`, `requestedRootId` = `{dev, ino}`, `requestedConfigDigest` | Exact identity: `{dev, ino}` is the filesystem identity; a bare ino is ambiguous across filesystems |
| Native coordinate | `nativeDirectory`, `nativeDataId`, `nativeWorkspaceId`, `nativeLaunchId` (each `{dev, ino}`), `nativeCheckpointDigest` | Exact identity of the native tree |
| Request / target | `requestId` (named request), `targetNodeId`/`targetAlias` (unset until handoff) | Handoff must be named, never implied |
| Commit inputs | `revision` (monotonic), `prevRecordDigest`, `writerId` | Comparison inputs for the commit authority (§4) — **not** a lock by themselves |
| State | `state` (§5) and typed evidence references (§5) | A state without its typed evidence is not a state |

Explicitly **not** stored: credentials, tokens, passwords, provider keys, model
session content, message bodies. Digests and `{dev, ino}` only. An empty
`auth.json` is **not** evidence that a root holds no secrets.

## 3. Two different conclusions: ordinary cleanup vs retained-root release

The single most important correction in revision 2: **"may this root be cleaned
up?"** and **"may this retained root be released?"** are two different questions
with two different answers, and neither may be produced by faking the other.

`cleanupDecision(root, participant)` — the one function every cleanup path asks:

| Outcome | When | Effect |
|---|---|---|
| `ordinary-cleanup` | **No retention intent or record has ever existed** for this root, and the root is the caller's own ordinary allocation | The **existing** flow applies unchanged: identity check, liveness check, then credential cleanup on their current paths. Ordinary never-prepared roots keep behaving exactly as today (#1272's requirement) |
| `retain` | A record exists in `prepared`, `retain-pending`, `retained-ready` or `handed-off` | Keep the root and the record; no cleanup |
| `retain` + `refuse(record-expected-missing)` | A record **should** exist (a prepare intent was observed) but is **lost, corrupt, unreadable, or unobservable**, or its digest chain does not verify | Keep everything; refuse. This is the *only* case where a missing record means unknown |
| `released` | A **durable** `released` record exists for this exact root identity (`{dev, ino}`) with its release evidence and the holding participant | Cleanup of the retained root is permitted |
| `refuse(...)` | Cannot decide (schema newer, mixed state, unreadable record, unqualified participant) | Keep everything; refuse with a reason code |

`ordinary-cleanup` is **not** `released`: it asserts "no retention was ever
claimed", while `released` asserts "a claim existed and was closed by evidence".
A `released` outcome cannot be produced by a reader, by a timeout, or by absence
of a record; it requires the durable release record of §5.

## 4. Record store, commit authority and write permissions

`revision` / `prevRecordDigest` / `writerId` are **comparison inputs, not a lock**.
The design therefore names an authority and a commit boundary:

- **Store**: one record file per source node in the owning uid's private state,
  plus a sibling lock file. Both are owner-uid private; cross-uid reads/writes are
  a refusal, not a merge.
- **Authority**: the record store is the **single serialization point**. A writer
  must hold the store's exclusive advisory lock for the whole commit (compare →
  write → publish). No other participant may commit concurrently.
- **Commit boundary** (one atomic publication): read current record → compare
  `expectedRevision` **and** `expectedPrevDigest` → write a new record to a temp
  file → `fsync` the temp file → `rename` over the record → `fsync` the parent
  directory → release the lock. Publication is atomic; the compare is meaningful
  **only** inside the lock.
- **Crash adjudication on read**: verify the digest chain. A record that does not
  verify, or that was published without a directory `fsync` we can observe, is
  `unknown` ⇒ `cleanupDecision = retain + refuse`. Never silently repair.
- **Lock ownership**: the lock file records the coordinator generation that holds
  it. A lock held by a dead generation is **not** auto-taken by a different
  participant; recovery requires the named recovery authority below.

Write permissions (who may write which state):

| State | Writer | Notes |
|---|---|---|
| `prepare-requested`, `prepared`, `retained-ready` | the **coordinator** whose generation matches the record | Any other writer ⇒ refusal, no write |
| `handed-off` | the **named target**, committing against the coordinator's revision | CAS; a losing target re-reads; the source record is kept |
| `released` | the participant that currently **holds** retention (coordinator or target) | Requires the release evidence of §5; never producible by a reader |
| `retain-pending` (from `prepared`) | the coordinator generation, **or** the named recovery authority | A `retain-pending` insert never overwrites another record's custody |
| `refused` (as a *record*) | **nobody** | A refusal is a **decision returned to the caller**, not a write. Readers cannot "overwrite a valid record with a refusal" |

Recovery authority: named explicitly (a participant identity + a precondition
proving the previous holder is gone) and its writable range is limited to
**inserting `retain-pending`** and repairing a torn publication of the *same*
revision — it may never write `retained-ready`, `handed-off` or `released`.

## 5. State machine, typed evidence and preconditions

States: `observed` → `prepare-requested` → `prepared` → (`retain-pending` |
`retained-ready`) → `handed-off` → `released`; plus the terminal decision
`refused` (returned, not written).

A generic `stateEvidence` digest cannot prove anything. Each edge therefore
consumes **typed** references:

```ts
type GenRef        = { pid: number; startTicks: string; uid: number; exeDigest: string };
type FsId          = { dev: string; ino: string };                     // exact filesystem identity
type WriterExclusion = { kind: "native-clean-exit" | "scoped-check"; ref: string };
type CredentialDisposition = { mode: "unchanged" | "cleaned"; ref: string };  // never carries secrets
type QualifiedOutcome = {
  kind: "qualified";
  coordinator: GenRef;                 // the writer must still be this generation
  nativeExit: { observedAt: string; ref: string };   // native *child* exit evidence
  writerExclusion: WriterExclusion;    // proof no other writer holds the tree
  credentialDisposition: CredentialDisposition;      // separate, never suppressed by retention
  target?: { nodeId: string; alias: string; confirmedBy: string };
};
```

| From → To | Executor | Precondition (exact evidence consumed) | Idempotency / concurrency | Crash |
|---|---|---|---|---|
| `observed` → `prepare-requested` | coordinator | identity group complete, **both coordinates present** with their `{dev, ino}`; **absent inodes do not qualify** (observation may record absence, preparation may not) | replay yields the same digest; concurrent prepares conflict in the lock | nothing durable ⇒ back to `observed` |
| `prepare-requested` → `prepared` | coordinator | §6 participant audit passed; durable commit per §4 with `revision=1`, `prevRecordDigest=null` | second writer loses the compare; identical replay is a no-op | torn write ⇒ `unknown` ⇒ retain + refuse |
| `prepared` → `retained-ready` | coordinator (generation must still match) | a `QualifiedOutcome` whose `coordinator` == the record's coordinator generation, with `nativeExit`, `writerExclusion`, `credentialDisposition` all present; any re-read of `{dev, ino}` that differs ⇒ refuse | duplicate outcomes collapse to one revision | re-read failure ⇒ `refused` |
| `prepared` → `retain-pending` | coordinator (or named recovery authority) | native child no longer matches its generation **and** no qualified outcome exists | idempotent (pessimistic) | this *is* the crash path |
| `retained-ready` → `handed-off` | named target | **#1238's intent journal and all-launcher refusal gate satisfied** (precondition, not a footnote); target identity read independently; CAS on `revision+1` | exactly one CAS wins; losers re-read | crash mid-handoff ⇒ both stores retained |
| `handed-off`/`retained-ready` → `released` | current holder | **#1239's final-history / lossless-restore gate satisfied** (precondition); explicit release evidence; `{dev, ino}` unchanged since the revision read | idempotent per `(recordId, revision)` | crash before durable release ⇒ still retained |
| any → `refused` (decision) | any participant | evidence missing/contradictory/mixed/newer schema | idempotent; **never writes a record** | never auto-clears, never replays |

## 6. Prepare eligibility requires an auditable cleanup-participant set

A state flag does **not** make old code stop: an old or external sweeper that does
not read the record will delete the native directory regardless of our refusal.
Refusal is therefore a **decision**, not a protection mechanism. Protection must
be established **before** promising `prepared`/retention:

For each relevant cleanup participant (every path that can delete or move the
native directory), the profile must show one of:

1. **Protocol-aware (coordinated)**: it consults `cleanupDecision` and honours
   `retain` — evidenced by its version/capability and the code path that reads the
   record (our own close/catch/after-exit paths and our stale sweeper, at or above
   the version that implements this contract); or
2. **Provably excluded**: it cannot reach the native directory — evidenced by its
   configured sweep roots/patterns (e.g. it only sweeps its own namespace); or
3. **Coordinated out of the window**: it is stopped/disabled for the retention
   window, with the evidence of that state.

If **any** relevant participant is `unknown` (no inventory entry, no configuration
evidence, no capability), the profile **refuses at prepare**. It does not accept a
record and hope.

Boundary of this model: it covers **named, auditable participants only**. We make
no claim of protection against arbitrary same-uid external programs; where such a
program can reach the native directory and cannot be excluded or coordinated, the
correct answer is refusal to prepare (and, if a record already exists,
`retain` + `refuse(unknown-sweeper)`).

## 7. Minimal source-owned API draft

Draft surface only; no runtime file is changed by this document, and none of these
may be implemented as a permanent `throw`.

```ts
// Read-only. Never acquires or implies a lease.
function readCustodyRecord(opts: { coordinatorNodeId: string; coordinatorAlias: string }):
  | { kind: "absent" }                                   // ⇒ ordinary-cleanup (see §3)
  | { kind: "record"; state: CustodyState; revision: number; digest: string; bound: CustodyIdentity }
  | { kind: "unknown"; reason: "unreadable" | "schema-newer" | "digest-chain" | "mixed" };

// The single question every cleanup path asks. Never returns "released" without a durable release record.
function cleanupDecision(opts: { root: FsId; participant: ParticipantIdentity }):
  "ordinary-cleanup" | "retain" | "released" | { refuse: RefusalReason };

// Durable prepare intent. Refuses unless §6's participant audit passes.
function requestRetentionPrepare(opts: {
  bound: CustodyIdentity; actor: ParticipantIdentity;
}): Promise<{ revision: number; digest: string }>;

// Qualified outcome of the owning coordinator generation (typed, see §5).
function recordQualifiedOutcome(opts: {
  recordId: string; expectedRevision: number; expectedPrevDigest: string;
  actor: ParticipantIdentity; outcome: QualifiedOutcome;
}): Promise<{ revision: number; digest: string }>;

// Named handoff. Requires the #1238 gate; CAS on revision; a losing target re-reads.
function handOffCustody(opts: {
  recordId: string; expectedRevision: number; expectedPrevDigest: string;
  actor: ParticipantIdentity; target: CustodyTarget;
}): Promise<{ revision: number; digest: string }>;

// Explicit release by the current holder. Requires the #1239 gate; idempotent per (recordId, revision).
function releaseCustody(opts: {
  recordId: string; expectedRevision: number; expectedPrevDigest: string;
  actor: ParticipantIdentity; evidence: ReleaseEvidence;
}): Promise<{ revision: number; digest: string }>;
```

Wiring contract (draft): close and the error path (which share one cleanup
closure) ask `cleanupDecision` **before** their existing predicate, and treat
`retain` / `refuse` as "keep". Because `absent` maps to `ordinary-cleanup`,
never-prepared roots keep today's behaviour. A writer must always pass the
expected revision **and** digest plus its own participant identity.

## 8. Cleanup participants, refusal reasons

| Participant | May do | Must refuse when |
|---|---|---|
| `close()` path | read `cleanupDecision`; release only via `releaseCustody` | `retain`/`refuse`; or the record's schema is newer |
| error/`catch` path | same (shared closure) | the identity predicate cannot be evaluated |
| after-exit cleanup | defer while `retain`/`refuse` | its caller predicate is the only evidence available |
| our stale sweeper | nothing about a retained root | the record is not `released` |
| external/old sweeper | **unknown** | always; retention must survive it (§6) |
| restart / mismatched version | read-only; refuse to adopt | capability or generation mismatch |

Reason codes: `no-record` (⇒ ordinary path, **not** a refusal), `schema-newer`,
`generation-mismatch`, `fs-identity-drift`, `digest-chain`, `unqualified-exit`,
`unknown-sweeper`, `mixed-state`, `record-expected-missing`, `participant-unknown`.

## 9. Responsibility boundaries

- **#1272** owns persistent marker/CAS/fsync implementation and source-owned
  preparation mechanics; S1 defines the schema, the commit authority and the
  ordinary-vs-retained distinction they must satisfy. S1 does not implement them.
- **#1238** owns the intent journal and the all-launcher refusal gate; that gate is
  a **precondition of `handed-off`** in §5, not only a boundary note.
- **#1239** owns the final-history / lossless-restore gate; it is a **precondition
  of `released`** in §5.
- **#1269** keeps its three items unfinished.

## 10. Rejection contracts

| Case | Contract |
|---|---|
| Unsupported profile | refuse `unsupported-profile`; never approximate |
| Cleanup participant unknown | refuse `participant-unknown` **at prepare** (§6) |
| Borrowed source (`v1-borrowed-*`) | refuse as custody; a cooperative read-only lease is not custody |
| `unsafe`/headless source | refuse; safety posture is part of the identity |
| Older source without this protocol | refuse `unqualified-participant`; retain |
| Mixed/unknown state | refuse `mixed-state`; retain **both** stores; no auto-clear/replay |
| Target identity unreadable | refuse; no implied handoff |

## 11. Decision tables (normal and adverse)

| Situation | Decision | Must not happen |
|---|---|---|
| Ordinary owned root, **never** any prepare intent/record | `ordinary-cleanup` — existing identity/liveness/credential cleanup runs unchanged | Must not be turned into permanent retention; must not require a `released` record |
| Prepare intent observed, but the record is missing/corrupt/unreadable | `retain` + `refuse(record-expected-missing)` | Must not be treated as `ordinary-cleanup`; must not be "repaired" silently |
| Two writers commit concurrently | Exactly one wins inside the lock (compare + atomic publish); the loser re-reads and retries with fresh inputs | No last-write-wins; no partially published record |
| A reader asks to refuse an existing valid record | A refusal **decision** is returned to that reader | The reader may not overwrite the custody/release record |
| Old/external sweeper reachable to the native dir and not qualifiable | refuse `unknown-sweeper` **before** `prepared`; if a record already exists, retain | Must not claim a state flag protects the root |
| `{dev, ino}` missing (never observed) at prepare time | refuse: preparation needs both coordinates present | Absence may be *recorded* by observation but never *qualifies* preparation |
| `{dev, ino}` drifted between prepare and outcome | `refused`, retain; both stores kept | No retry with stale coordinates |
| Outcome incomplete (no `nativeExit` / `writerExclusion` / `credentialDisposition`) | Stay `prepared`; not `retained-ready` | A generic evidence digest must not stand in for these |
| Coordinator generation exited, then something writes an outcome | refuse: writer generation must match the record's coordinator | A stale exited process may not author an outcome |
| Credential cleanup needed while a root is retained | credential cleanup proceeds on its **own** path | Must not be disabled by retention; must not copy real auth to a target |

## 12. Acceptance plan for the next slice (not executed here)

Positive: (1) `observed → prepared` commits a revision atomically and a replay is
a no-op; (2) a complete `QualifiedOutcome` ⇒ `retained-ready`, then a named handoff
with the #1238 gate satisfied advances the revision by exactly 1 while keeping the
source record; (3) an explicit release with the #1239 gate satisfied is the only
path that yields `released`.

Negative (each witnessed red): (1) concurrent commits ⇒ one CAS wins, loser
re-reads; (2) `{dev, ino}` drift ⇒ refuse + retain; (3) crash after
`prepare-requested` before publish ⇒ no claim; (4) crash mid-handoff ⇒ both stores
retained; (5) `schemaVersion+1` ⇒ refuse; (6) unqualifiable sweeper ⇒ refuse at
prepare (and retention survives an external sweep when a record exists); (7)
**never-prepared root still gets ordinary cleanup** (the regression that motivates
§3); (8) incomplete outcome ⇒ never `retained-ready`; (9) empty `auth.json` ⇒
credential cleanup still runs.

None of these runs natively or on an original machine in this slice.

## 13. What this document does not claim

It does not prove custody, writer exclusion, final native history, backup/restore
or cutover qualification; it does not implement markers, cleanup, registry or
startup changes; it does not release, migrate or publish anything; it does not
turn registration, idle, a clean-shutdown flag or a process-reference scan into a
lease; and it does not claim to protect a root from arbitrary same-uid external
programs (§6).
