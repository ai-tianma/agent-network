// #1293 — decide whether a newly created/started opencode-cli node may REUSE an
// already-running OpenCode server on this machine instead of spawning a new one.
//
// This module is decision + registry only. It never spawns, never signals a
// process, and never reads credentials: the caller still owns the actual
// attach/serve lifecycle. Every path here FAILS CLOSED — an unreadable, stale,
// cross-identity, or non-loopback candidate is a fallback, never a reuse.
//
// Identity rule (mirrors writeCreatedOpencodeProfile): a server bound to node A
// is reusable ONLY by an exact node A retry. A different node id, a missing
// binding, or an unreadable record falls back to a fresh server so credentials
// are never silently shared across identities.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const OPENCODE_SERVER_REUSE_REGISTRY_FILE = "opencode-server-reuse.json";

/** One running server this daemon started and may consider for reuse. */
export interface OpencodeServerReuseCandidate {
  /** Loopback URL of the running serve (http://127.0.0.1:PORT). */
  url: string;
  /** Absolute project directory the serve was launched with. */
  directory: string;
  /** Node identity the server is bound to; reuse requires an exact match. */
  nodeId: string;
  alias: string;
  /** Same-uid requirement: the daemon uid that owns the serve process. */
  uid: number;
  /** PID + start ticks guard against PID reuse (attach-tui semantics). */
  pid: number;
  startTicks: number | null;
  generation: "v1" | "v2";
}

export interface OpencodeServerReuseInput {
  /** Target node being created/started. */
  nodeId: string;
  alias: string;
  /** Workdir root the daemon manages; candidates outside it are refused. */
  workdirRoot: string;
  /** Daemon uid; candidates owned by another uid are refused. */
  uid: number;
  /** Generation the target node requires; mismatch is refused. */
  generation: "v1" | "v2";
  /** Records read from the machine registry. */
  candidates: readonly (OpencodeServerReuseCandidate | null | undefined)[];
  /** opt-in flag: "off" preserves today's always-spawn behaviour verbatim. */
  mode?: "same-identity" | "off";
  /** Live process identity probe; default treats a pid as alive when unknown. */
  probeAlive?: (pid: number, startTicks: number | null) => boolean;
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
 * reason, so a broken registry can never turn into an unsafe reuse.
 */
export function decideOpencodeServerReuse(input: OpencodeServerReuseInput): OpencodeServerReuseDecision {
  if ((input.mode ?? "same-identity") === "off") {
    return { decision: "fallback", reason: "reuse_off" };
  }
  const records = input.candidates
    .filter((c): c is OpencodeServerReuseCandidate => !!c && typeof c === "object");
  if (records.length === 0) return { decision: "fallback", reason: "no_candidate" };

  const probeAlive = input.probeAlive ?? (() => true);
  const reasons: string[] = [];
  for (const candidate of records) {
    const refusal = refuseCandidate(input, candidate, probeAlive);
    if (refusal) { reasons.push(refusal); continue; }
    return { decision: "reuse", reason: "same_identity_live", candidate };
  }
  // Surface the most specific refusal so logs stay actionable.
  return { decision: "fallback", reason: reasons[0] ?? "no_candidate" };
}

function refuseCandidate(
  input: OpencodeServerReuseInput,
  candidate: OpencodeServerReuseCandidate,
  probeAlive: (pid: number, startTicks: number | null) => boolean,
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
  if (typeof candidate.pid !== "number" || !Number.isFinite(candidate.pid) || candidate.pid <= 0) {
    return "missing_pid";
  }
  if (!probeAlive(candidate.pid, candidate.startTicks ?? null)) return "not_live";
  return null;
}

/** Machine registry path under the daemon's managed root (0600, never credentials). */
export function opencodeServerReuseRegistryPath(root: string): string {
  return join(root, OPENCODE_SERVER_REUSE_REGISTRY_FILE);
}

/** Returns [] on any read/parse failure — a broken registry means "reuse nothing". */
export function readServerReuseCandidates(root: string): OpencodeServerReuseCandidate[] {
  try {
    const raw = readFileSync(opencodeServerReuseRegistryPath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const list = Array.isArray(parsed.servers) ? parsed.servers : Array.isArray(parsed) ? parsed : [];
    return list.filter((c): c is OpencodeServerReuseCandidate => !!c && typeof c === "object");
  } catch {
    return [];
  }
}

/** Host label for evidence; never carries a path or credential. */
export function reuseEvidenceHost(): string {
  try { return hostname(); } catch { return "unknown"; }
}
