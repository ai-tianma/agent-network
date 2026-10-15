// #1293 — decide whether a newly created/started opencode-cli node may REUSE an
// already-running OpenCode server on this machine instead of spawning a new one.
//
// PURE DECISION ONLY. This module never spawns, never signals a process, never
// reads credentials, and — deliberately — never reads a file: the candidates it
// decides over are supplied by the caller. The host shared-server registration
// is owned and read by the existing shared-registry reader (private-file
// discipline: canonical path, single-link regular file, owner-uid and 0600 mode
// checks), so this decision module introduces NO second registry and no second
// file-trust surface. See PR #2776 for the authoritative `host shared registry →
// create default-selects shared → shared runtime` path this helper feeds.
//
// Every path FAILS CLOSED — an unreadable, stale, cross-identity, or
// non-loopback candidate is a fallback, never a reuse.
//
// Identity rule (mirrors writeCreatedOpencodeProfile): a server bound to node A
// is reusable ONLY by an exact (nodeId, alias) retry, AND only when a live
// pid+startTicks probe confirms the recorded process still exists. A different
// node id or alias, a missing node binding, a missing startTicks, an absent or
// throwing probe, or a malformed record all fall back to a fresh server so
// credentials are never silently shared across identities.

/** One running server this daemon started and may consider for reuse. */
export interface OpencodeServerReuseCandidate {
  /** Loopback URL of the running serve (http://127.0.0.1:PORT). */
  url: string;
  /** Absolute project directory the serve was launched with. */
  directory: string;
  /** Node identity the server is bound to; reuse requires an exact match. */
  nodeId: string;
  /** Alias is part of the binding; reuse requires an exact match too. */
  alias: string;
  /** Same-uid requirement: the daemon uid that owns the serve process. */
  uid: number;
  /** PID + start ticks guard against PID reuse (attach-tui semantics). */
  pid: number;
  /** `startTicks` is the only defense against PID reuse; null is refused. */
  startTicks: number | null;
  generation: "v1" | "v2";
}

export interface OpencodeServerReuseInput {
  /** Target node being created/started. */
  nodeId: string;
  /** Target alias; must match the candidate's binding alias exactly. */
  alias: string;
  /** Workdir root the daemon manages; candidates outside it are refused. */
  workdirRoot: string;
  /** Daemon uid; candidates owned by another uid are refused. */
  uid: number;
  /** Generation the target node requires; mismatch is refused. */
  generation: "v1" | "v2";
  /**
   * Candidate records. The caller must obtain these from the authoritative
   * host shared-server registry reader, which enforces the private-file
   * (canonical path / single link / owner uid / 0600) discipline. This module
   * does not read or trust files itself.
   */
  candidates: readonly (OpencodeServerReuseCandidate | null | undefined)[];
  /** opt-in flag: "off" preserves today's always-spawn behaviour verbatim. */
  mode?: "same-identity" | "off";
  /**
   * Live process identity probe. It is REQUIRED for reuse — it must observe that
   * `pid` is alive AND still the same process as `startTicks`. It is never
   * defaulted to "alive": a missing probe is a fallback, and a throwing probe is
   * caught and treated as a fallback so this function never escapes by throwing.
   */
  probeAlive?: (pid: number, startTicks: number) => boolean;
}

export interface OpencodeServerReuseDecision {
  decision: "reuse" | "fallback";
  /** Machine-readable reason; also the audit field for the launch evidence. */
  reason: string;
  /** Reused candidate when decision === "reuse". */
  candidate?: OpencodeServerReuseCandidate;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Loopback only: reuse must never target a routable address. */
export function isLoopbackServeUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "http:"
    && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)
    && !parsed.username && !parsed.password;
}

function normalizeUid(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Pure decision. Never throws: any malformed input is a fallback with a
 * reason, so a broken or hostile candidate list can never turn into an unsafe
 * reuse.
 */
export function decideOpencodeServerReuse(input: OpencodeServerReuseInput): OpencodeServerReuseDecision {
  if ((input.mode ?? "same-identity") === "off") {
    return { decision: "fallback", reason: "reuse_off" };
  }
  const records = input.candidates
    .filter((c): c is OpencodeServerReuseCandidate => !!c && typeof c === "object");
  if (records.length === 0) return { decision: "fallback", reason: "no_candidate" };
  // Fail closed without an observation path: reuse is never approved on the
  // strength of an on-disk record alone.
  const probe = input.probeAlive;
  if (typeof probe !== "function") return { decision: "fallback", reason: "probe_unavailable" };

  const reasons: string[] = [];
  for (const candidate of records) {
    const refusal = refuseCandidate(input, candidate, probe);
    if (refusal) { reasons.push(refusal); continue; }
    return { decision: "reuse", reason: "same_identity_live", candidate };
  }
  // Surface the most specific refusal so logs stay actionable.
  return { decision: "fallback", reason: reasons[0] ?? "no_candidate" };
}

function refuseCandidate(
  input: OpencodeServerReuseInput,
  candidate: OpencodeServerReuseCandidate,
  probe: (pid: number, startTicks: number) => boolean,
): string | null {
  if (!isLoopbackServeUrl(candidate.url)) return "not_loopback";
  if (typeof candidate.directory !== "string" || !candidate.directory
    || !samePath(candidate.directory, input.workdirRoot)) {
    return "directory_mismatch";
  }
  if (candidate.generation !== input.generation) return "generation_mismatch";
  const candidateUid = normalizeUid(candidate.uid);
  if (candidateUid === null || candidateUid !== input.uid) return "foreign_uid";
  // Fail-closed identity: only an exact node-id match may reuse a bound server.
  if (typeof candidate.nodeId !== "string" || !candidate.nodeId) return "missing_binding";
  if (candidate.nodeId !== input.nodeId) return "identity_mismatch";
  // Alias is part of the binding contract; a same-node/other-alias record must
  // not approve reuse.
  if (typeof candidate.alias !== "string" || !candidate.alias) return "missing_binding";
  if (candidate.alias !== input.alias) return "alias_mismatch";
  if (typeof candidate.pid !== "number" || !Number.isFinite(candidate.pid) || candidate.pid <= 0) {
    return "missing_pid";
  }
  const startTicks = candidate.startTicks;
  if (typeof startTicks !== "number" || !Number.isFinite(startTicks)) return "missing_start_ticks";
  let alive: boolean;
  try {
    alive = probe(candidate.pid, startTicks);
  } catch {
    return "probe_error";
  }
  if (alive !== true) return "not_live";
  return null;
}
