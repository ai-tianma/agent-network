# Versioned custody state, CAS authority and cleanup contract for V1 retention (S1 design, #1334)

Status: **design draft only** (revision 5, after review of `f9910dc3`). This document
defines the persistent structures, the cleanup decision, the commit authority and the
permission contract for a future V1 exact-instance retention/custody protocol. It is
**not** a runtime implementation, **not** a custody proof, and it changes no runtime file.

Lineage: first design slice of #1269 (prerequisite line of #1238; #1269 is **not**
moved and its contract/native/main items remain **unfinished**). S2/S3 are not
dispatched; #1272 and #1239 are not taken here. Design delivery time, not a migration ETA.

## 1. Verified source baseline (current `main`)

Re-read from `main` at `6ed5b6859fad31ab65449c79d98bfb22f119169c` on 2026-10-16:

- `v1-safe-retention-request.ts` — one observation with a digest; refuses; byte-identical
  JSON reconstruction is not a durable recovery/custody entry.
- `v1-owned-safe-topology.ts` — read-only observation; current-process allocation and
  stable private files are observations, never final history or a custody lease.
- `v1-migration-plan.ts` — refuses; has an explicit no-intent-or-lease refusal path.
- `close-cleanup.ts` — `cleanupAfterExit` retries a caller-supplied identity/live-process
  predicate; the caller retains the root on timeout/unknown.
- `runtime.ts` — the two product call sites (close path, error path) share one closure.
- `v1-borrowed-tui.ts` — a cooperative, read-only admission to an already-live node's
  lease; not custody of an owned runtime.
- No open custody/retention pull request exists on `main` at writing time.

Registration, idle, a clean-shutdown flag or a process-reference scan are **never**
accepted as custody, writer exclusion, final history or a qualified release.

## 2. Persistent structures (names are the contract)

All of these live in the owning uid's private state, **outside the root being cleaned**:

| Path | Kind | Rule |
|---|---|---|
| `lock` | stable inode, **created once, never replaced** | Every phase (cleanup decision, reservation, prepare, commit, release) serializes on this inode |
| `participation/<allocationId>.json` | **participation basis** — immutable per allocation | Written by the allocation flow **before** any retention preparation. Carries `{allocationId, rootId {dev,ino}, generation, nonParticipation: bool, at}`. An affirmative `nonParticipation: true` attestation for **this exact allocation/root generation** is the **only** thing that licenses ordinary cleanup |
| `fence/<allocationId>.json` | retention fence | Written (temp → fsync → rename → **fsync dir**) as prepare's first durable step. Presence ⇒ retain/refuse, regardless of any record |
| `reservation/<allocationId>.json` | **irrevocable** cleanup reservation | Written before any deletion. Presence ⇒ **prepare must fail** |
| `records/<revision>-<digest>.json` | **immutable** record — full old versions are kept, never replaced | Each record carries `chain: {previousRevision, previousDigest}` which must resolve to a **readable, still-present** file `records/<previousRevision>-<previousDigest>.json` |
| `current` | pointer file | Names `{revision, digest}` of the current record; published atomically |
| `confirmation/<revision>-<digest>.json` | **commit confirmation** | `{recordRef:{revision,digest}, chainHead, at}`; the durable evidence that publish completed |
| `receipts/<revision>-<digest>.json` | **commit receipt** | Returned to the writer by the commit function; binds `{recordRef, confirmationRef, chainHead}` |

Credential material is **never** stored here (no tokens, passwords, provider keys, model
session content). An empty `auth.json` is not evidence that a root holds no secrets.

## 3. The cleanup decision (replaces the earlier conflicting rules)

`cleanupDecision(allocationId, rootId, participant)` is asked **while holding `lock`**,
and returns exactly one of:

| Outcome | Condition (all evaluated under `lock`) | Effect |
|---|---|---|
| `retain` | a **fence** exists, or a record exists in any state other than `released`, or a reservation exists without a completed cleanup | Keep root and artifacts; no cleanup |
| `retain` + `refuse(record-expected-missing)` | the fence or participation basis shows retention **was** prepared (or a confirmation exists) while the record is missing, corrupt, or its chain does not resolve | Keep everything; refuse |
| `ordinary-cleanup` | the participation basis holds **`nonParticipation: true` for this exact allocation/root generation**, **no fence**, **no reservation**, and no record | Identity + liveness checks, then credential cleanup on their current paths |
| `refuse(...)` | none of the above is provable (no basis entry, newer schema, unreadable artifacts, unqualified participant) | Keep everything; refuse with a reason code |

Three rules replace the conflicting sentences of revisions 1–4:

1. **A durable fence/intent always means retain/refuse.** Missing acknowledgement (no
   confirmation, no ACK) **never** reverts to ordinary. The only way out of an
   *uncommitted* fence is the explicit retraction in §4's crash table.
2. **`absent` grants nothing.** "No basis entry" ⇒ `refuse(no-participation-proof)`,
   **not** ordinary. Ordinary requires the affirmative non-participation attestation of
   §2. Allocations created before the participation basis exists therefore **refuse**;
   the profile must not silently treat them as ordinary.
3. **Cleanup never reads, releases the lock, then deletes.** It either (a) holds `lock`
   until the delete has completed, or (b) first persists the **irrevocable reservation**
   `reservation/<allocationId>.json`. After a reservation exists, **prepare must fail**
   (`cleanup-reserved`); a reservation is never revoked by a later prepare.

Required outcomes for the two orderings he named:

| Ordering | Result |
|---|---|
| cleanup first obtains ordinary (reservation written), then a prepare arrives | **Prepare fails** `cleanup-reserved`. The root is cleaned normally; no retention is ever claimed |
| retention was prepared but the record is lost | `retain` + `refuse(record-expected-missing)` — provable **without** the record, because the fence/participation basis was persisted outside the root **before** preparation |

## 4. Commit protocol, chain, confirmation and crash points

`revision` / `previousDigest` are **comparison inputs**; the authority and the commit
boundary are:

- **Serialization**: every phase holds `lock` (§2), the stable inode that is never
  replaced. **CAS compares the current complete record digest** (`digest` of
  `current`'s target file), not just the revision number.
- **Publish protocol** (each step includes the durability of the *new directory entry*):
  1. write record temp in `records/` → `fsync` file → `rename` to
     `records/<revision>-<digest>.json` → **`fsync` the `records/` directory**;
  2. write confirmation temp → `fsync` file → `rename` to
     `confirmation/<revision>-<digest>.json` → **`fsync` that directory**;
  3. write `current` temp → `fsync` file → `rename` over `current` → **`fsync` its dir**;
  4. **ACK** the caller only after step 3's directory fsync.
- **Chain**: `previousDigest` points at a **readable, still-present** immutable record
  file; `chainHead` in the confirmation is the digest of the oldest retained revision of
  the chain. A chain whose older file is missing ⇒ the record is `unknown` ⇒ retain+refuse.
- **No self-reference**: an outcome may **not** carry its own commit evidence. The commit
  function **consumes** the `QualifiedOutcome` and **returns a separate `CommitReceipt`**;
  readers verify the binding `record ↔ outcome ↔ confirmation ↔ receipt` (§5).
- **Lock semantics honesty**: a POSIX advisory lock is **released by the kernel when the
  holder dies**. A dead pid does **not** still hold `lock`. Therefore a free `lock` is
  **not** takeover authority: takeover requires the named recovery authority + the
  evidence in the table below.

**Recovery by physical crash point** (each row is a physical point, not an abstract
"missing" group). The recovery authority may **only re-persist the same revision with its
originally valid evidence**; it may **never** manufacture qualification, and never
advance the revision:

| Crash point | On-disk state | Verdict | Allowed recovery |
|---|---|---|---|
| after fence written, before any record temp | fence only | retain | authority may **retract the uncommitted fence** with evidence (no confirmation ever existed, generation gone); then §3's ordinary rules apply |
| during record temp write | partial temp file | retain | ignore the temp (it is not a record); fence stands |
| after record rename, before `records/` dir fsync | record maybe present, no confirmation | `unknown` ⇒ retain | authority re-publishes the **same revision** through the protocol, using the original outcome |
| after `records/` fsync, before confirmation | record durable, confirmation absent | `unknown` ⇒ retain + `refuse(commit-unconfirmed)` | authority writes the confirmation for the **same revision/digest** (original evidence exists) |
| after confirmation, before `current` rename | record + confirmation exist, pointer stale | retain | authority advances `current` to the already-confirmed `{revision,digest}` (no new qualification) |
| after `current` rename, before dir fsync, before ACK | pointer maybe replaced | retain + re-read | authority re-runs step 3 only |
| after ACK | committed | committed | none |

## 5. Types: separate exit from a real admission barrier

```ts
type GenRef = { pid: number; startTicks: string; uid: number; exeDigest: string };
type FsId   = { dev: string; ino: string };              // exact filesystem identity

// The native child having exited is ONE fact; it is never an exclusion proof.
type NativeExit = { pid: number; startTicks: string; observedAt: string; ref: string };

// The ONLY accepted write-exclusion contract: a named controller refuses NEW
// launch/adoption for this cohort, bound to allocation/root identity and an epoch.
// (Metadata locks and "no writer was visible" are NOT barriers and were removed.)
type CohortAdmissionBarrier = {
  kind: "cohort-admission-barrier";
  controller: GenRef;            // the named participant enforcing admission
  allocationId: string;          // bound identity
  rootId: FsId;                  // bound identity
  epoch: number;                 // barrier epoch; a mismatch invalidates the claim
  coveredParticipants: string[]; // which launchers/adopters the audit proved are covered
  ref: string;                   // evidence artifact for the admission refusals
};
type CredentialDisposition = { mode: "unchanged" | "cleaned"; ref: string };

type QualifiedOutcome = {
  kind: "qualified";
  coordinator: GenRef;                 // the writer must still be this generation
  nativeExit: NativeExit;              // existing writers: independent exit evidence
  barrier: CohortAdmissionBarrier;     // new writers: the admission barrier above
  credentialDisposition: CredentialDisposition;
  target?: { nodeId: string; alias: string; confirmedBy: string };
};                                     // NOTE: no `commit` field — see §4

type CommitReceipt = { recordRef: { revision: number; digest: string };
                       confirmationRef: string; chainHead: string };
```

Requirements that make the barrier usable:

- **Existing writers** need their own `nativeExit` (or independent exclusion) evidence;
  the barrier only stops **new** launch/adoption.
- **Fail-closed admission**: while a barrier is claimed, participating launchers default
  to **refusing new writers**; if the barrier's controller crashed or its version
  mismatches, admission still refuses — a barrier does not expire.
- **No time-based exclusion**: `heldUntil: null`, a timestamp, or a window is **not**
  proof of maintaining exclusion. A barrier is lifted **only by a named handoff or
  release** event (published like any other state change), never by time.
- **Audit is evidence, not the barrier**: the participant audit/`coveredParticipants`
  proves *which* participants the barrier covers (§6); it is never itself the barrier.
- Consistent with §6's limited-cooperation model: a profile whose participants cannot be
  covered **refuses**; no claim of protecting arbitrary same-uid external programs.

## 6. Prepare eligibility requires an auditable participant set

A state flag does not stop old code: an old/external sweeper that ignores these artifacts
will delete the native directory anyway. Protection must be established **before**
promising `prepared`:

For every relevant cleanup participant and every launcher/adopter that could write,
the profile must show **protocol-awareness** (a version/code path that reads the fence /
asks `cleanupDecision` / honours the barrier), **provable exclusion** (its configured
roots/patterns cannot reach the native directory), or **coordinated out** (stopped with
evidence). Any unknown participant ⇒ **refuse at prepare** (`participant-unknown`).

Where a participant cannot be covered, the correct answers are: refuse to prepare; and if
a fence already exists, `retain` + `refuse(unknown-sweeper)`.

## 7. API draft (executors named, no self-reference)

```ts
// All of these run while holding `lock` (§2). None may be implemented as a permanent throw.
function readStructures(opts: { allocationId: string }):
  | { kind: "absent" }                  // ⇒ refuse(no-participation-proof); NOT ordinary
  | { kind: "readable"; basis?: ParticipationBasis; fence?: Fence; record?: Record;
      confirmation?: Confirmation; reservation?: Reservation }
  | { kind: "unknown"; reason: "unreadable" | "schema-newer" | "chain-broken" | "mixed" };

function cleanupDecision(opts: { allocationId: string; rootId: FsId; participant: ParticipantIdentity }):
  "ordinary-cleanup" | "retain" | "released" | { refuse: RefusalReason };

// Irrevocable, written before any deletion. After it exists, prepare fails.
function reserveCleanup(opts: { allocationId: string; rootId: FsId; actor: ParticipantIdentity }):
  Promise<{ reservationRef: string }>;

// Prepare: first durable step is the fence (temp→fsync→rename→fsync dir); then the commit.
function requestRetentionPrepare(opts: { allocationId: string; rootId: FsId;
  actor: ParticipantIdentity }): Promise<{ revision: number; digest: string } | { refuse: RefusalReason }>;

// Consumes the outcome, returns an INDEPENDENT receipt (§4).
function commitOutcome(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; outcome: QualifiedOutcome;
}): Promise<CommitReceipt>;

function handOffCustody(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; target: CustodyTarget;
}): Promise<CommitReceipt>;                    // precondition: #1238 gate satisfied

function releaseCustody(opts: { allocationId: string; expectedRevision: number;
  expectedRecordDigest: string; actor: ParticipantIdentity; evidence: ReleaseEvidence;
}): Promise<CommitReceipt>;                    // precondition: #1239 gate satisfied
```

Wiring: close and the error path (one shared cleanup closure) call `cleanupDecision`
under `lock` **before** their existing predicate; `retain`, `refuse` and `absent` all
mean keep. Only `ordinary-cleanup` (with its affirmative attestation) or `released`
permits the existing flow.

## 8. Refusal reason codes

`no-participation-proof`, `cleanup-reserved`, `record-expected-missing`,
`commit-unconfirmed`, `chain-broken`, `schema-newer`, `generation-mismatch`,
`fs-identity-drift`, `barrier-epoch-mismatch`, `participant-unknown`, `unknown-sweeper`,
`mixed-state`, `unqualified-participant`.

## 9. Responsibility boundaries (unchanged scope)

- **#1272** owns the persistent marker/CAS/fsync **implementation** and source-owned
  preparation mechanics; S1 defines the structures (§2), the cleanup decision (§3) and
  the commit boundary (§4) they must satisfy.
- **#1238** owns the intent journal and the all-launcher refusal gate: a **precondition of
  `handOffCustody`**. **#1239** owns the final-history / lossless-restore gate: a
  **precondition of `releaseCustody`**. **#1269** keeps its three items unfinished.

## 10. Decision tables

| Situation | Decision | Must not happen |
|---|---|---|
| Ordinary root with `nonParticipation: true` for this allocation/root generation, no fence/reservation/record | `ordinary-cleanup` | Must not be turned into permanent retention |
| No basis entry (`absent`) | `refuse(no-participation-proof)` | Must not be treated as ordinary (pre-basis allocations refuse) |
| Fence exists, record missing/corrupt/chain-broken | `retain` + `refuse(record-expected-missing)` | Must not revert to ordinary without the explicit fence retraction of §4 |
| Cleanup holds the lock through deletion, then prepare arrives | prepare **fails** (`cleanup-reserved`) if a reservation exists | A later prepare may not revoke a reservation |
| Concurrent commits | exactly one wins: CAS on the **complete current record digest** under `lock` | No last-write-wins; no replaced/rewritten record file |
| Record durable but confirmation absent | `unknown` ⇒ retain + `refuse(commit-unconfirmed)` | Must not be read as durable; no "probably fsynced" |
| Chain's older record missing | `unknown` ⇒ retain + refuse | No silent re-anchoring of the chain |
| A reader wants a record to be refused | a refusal **decision** is returned | Readers may not overwrite a valid record |
| Barrier controller crashed / version mismatch | admission still refuses new writers | No time-based or null-`heldUntil` exclusion claim |
| Metadata lock free (holder died) | no takeover authority | Must not claim a dead pid still holds the kernel lock |
| Native exit observed, no barrier | stay `prepared` | Exit must never stand in for exclusion |
| Credential cleanup needed while a root is retained | credential cleanup runs on its own path | Must not be disabled by retention; no real auth to a target |

## 11. Acceptance plan for the next slice (not executed here)

Positive: (1) basis with `nonParticipation: true` ⇒ ordinary cleanup proceeds unchanged;
(2) fence + commit ⇒ record + confirmation + `current` consistent, and the receipt binds
to them; (3) a named handoff with the #1238 gate satisfied advances the revision by one
while keeping every old record file; (4) release with the #1239 gate satisfied is the only
path to `released`.

Negative (each witnessed red): (1) concurrent commits ⇒ one CAS wins; (2) cleanup vs
in-flight prepare ⇒ prepare fails after a reservation, and the root is cleaned normally;
(3) fence with a lost record ⇒ retain + refuse; (4) each physical crash point of §4
produces its listed verdict; (5) record without confirmation ⇒ `unknown`; (6) chain gap ⇒
`unknown`; (7) `absent` ⇒ refuse (not ordinary); (8) unqualifiable sweeper/launcher ⇒
refuse at prepare; (9) metadata lock free after a crash ⇒ **no** takeover without the
authority; (10) exit without a barrier ⇒ never `retained-ready`; (11) barrier epoch
mismatch or crashed controller ⇒ admission still refuses; (12) empty `auth.json` ⇒
credential cleanup still runs.

## 12. What this document does not claim

No custody, writer exclusion, final native history, backup/restore or cutover
qualification is claimed. No runtime, marker, cleanup, registry or startup change is
made. Nothing is released, migrated or published. Registration, idle, clean shutdown and
process scans are never leases. Protection from arbitrary same-uid external programs is
**not** claimed (§6).
