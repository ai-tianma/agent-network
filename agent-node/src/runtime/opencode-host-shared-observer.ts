// #1313 / parent #1302 — Linux OBSERVATION PROVIDER for the host-shared
// OpenCode server: REAL PROCESS EVIDENCE, and nothing more.
//
// Scope split agreed with 通信牛 (2026-10-16):
//   * this module = "what process is really behind this loopback URL", read-only;
//   * #1302 = generation/evidence BINDING and the reuse decision. A consumer that
//     cannot prove a generation must refuse reuse; that call is NOT made here.
//
// Why it returns `processEvidence` and not an observation with a `generation`:
// an exact argv match, the executable path, a file named `opencode` and the
// caller's expectation are all *diagnostics* — none of them proves the
// process's OpenCode generation. So this module never fills a proven generation
// field; it reports the argv-contract shape under `diagnostics` and says so.
//
// ONE chain, from ONE process, then re-verified:
//   /proc/net/tcp LISTEN inode on 127.0.0.1:<port>
//     → /proc/<pid>/fd/* "socket:[inode]"  (the holding process)
//     → /proc/<pid> uid
//     → /proc/<pid>/stat start ticks + liveness
//     → /proc/<pid>/cmdline  (diagnostic)
//   then inode/pid/uid/startTicks are read AGAIN and must be identical. Any
//   drift, permission wall or multi-candidate answer is an explicit failure —
//   a stale success is never returned, and this module never throws.
//
// No daemon wiring, no second registry, no credential read, no `close`
// lifecycle, no import of any reuse/guard module: the type below is defined
// right here so the slice stays independently reviewable.

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import { opencodeBackendFor } from "./opencode-backend.js";
import { readLiveProcess } from "./opencode-copresence/launcher-health.js";

/** Why a process observation could not be produced. Every value is a refusal. */
export type HostSharedObserveReason =
  | "unsupported_platform"
  | "url_not_supported"
  | "no_listener"
  | "ambiguous_listener"
  | "socket_owner_not_found"
  | "permission_denied"
  | "identity_mismatch";

/**
 * DIAGNOSTIC ONLY. `argvContract` records which serve-argv shape was seen. It is
 * **not** proof of a generation: a process can be launched with any argv, and a
 * generation change upstream changes the shape without the process changing
 * identity. A consumer that needs a proven generation must bind it itself and
 * refuse reuse when it cannot (#1302) — this field must never be promoted into
 * a "proven generation".
 */
export interface HostSharedServeDiagnostics {
  /** Executable behind the process, when readable: /proc/<pid>/exe. */
  executable: string | null;
  /** argv from its `serve` token onward (empty when there is no `serve`). */
  argvTail: string[];
  /** Which serve-argv shape was seen. Diagnostic; never proves a generation. */
  argvContract: "v1" | "v2" | "none" | "ambiguous";
  /** Why `argvContract` is evidence of nothing on its own. */
  argvContractNote: string;
}

/** What the OS can actually prove about the process behind a loopback URL. */
export interface HostSharedProcessEvidence {
  /** The validated literal loopback URL this evidence is about. */
  url: string;
  /** 127.0.0.1 only: borrowing must never target a routable address. */
  host: "127.0.0.1";
  port: number;
  /** LISTEN socket inode the pid was bound through (identical in both reads). */
  listenInode: string;
  /** The single process holding that socket. */
  pid: number;
  /** uid owning /proc/<pid>. */
  uid: number;
  /** /proc/<pid>/stat start ticks — the defense against PID reuse. */
  startTicks: number;
  diagnostics: HostSharedServeDiagnostics;
}

export type HostSharedObserveResult =
  | { ok: true; processEvidence: HostSharedProcessEvidence }
  | { ok: false; reason: HostSharedObserveReason };

export interface LiveProc {
  pid: number;
  ticks: string;
  state: string;
}

/** Injectable /proc surface. Defaults read the real filesystem; the tests (unit
 *  and the isolated Docker suite) use real processes or scripted drift. */
export interface HostSharedObserverDeps {
  platform?: NodeJS.Platform;
  readProcFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  readLink?: (path: string) => string;
  procUid?: (pid: number) => number | undefined;
  liveProcess?: (pid: number) => LiveProc | undefined;
  /** The repo's single-source serve argv for a generation (diagnostics only). */
  serveArgsFor?: (generation: "v1" | "v2", host: string, port: number) => readonly string[];
  /** Executable basename accepted next to the argv block (a filter, not proof). */
  executableBasename?: string;
}

const LOOPBACK_HOST = "127.0.0.1";
const OPENCODE_BASENAME = "opencode";
/** LISTEN state in /proc/net/tcp. */
const TCP_LISTEN = "0A";
/** 127.0.0.1 little-endian, the only address form this provider observes. */
const LOOPBACK_HEX = "0100007F";
const CONTRACT_NOTE =
  "argv shape is a launch-argument diagnostic only: it cannot prove a process's " +
  "OpenCode generation, so it must never be promoted into a proven generation " +
  "(binding belongs to the reuse decision, not to process observation).";

function errCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function defaultDeps(): Required<HostSharedObserverDeps> {
  return {
    platform: process.platform,
    readProcFile: (path) => readFileSync(path, "utf8"),
    readDir: (path) => readdirSync(path),
    readLink: (path) => readlinkSync(path),
    procUid: (pid) => statSync(`/proc/${pid}`).uid,
    liveProcess: (pid) => {
      // Same /proc/<pid>/stat reader the launcher health check uses: undefined
      // for a gone or zombie process.
      const proc = readLiveProcess(pid);
      return proc ? { pid: proc.pid, ticks: proc.ticks, state: proc.state } : undefined;
    },
    serveArgsFor: (generation, host, port) =>
      opencodeBackendFor(generation).serveArgs({ hostname: host, port }),
    executableBasename: OPENCODE_BASENAME,
  };
}

/** Classify the serve argv shape. Diagnostics only — see CONTRACT_NOTE. */
function argvTailOf(argv: readonly string[]): string[] {
  const serveIndex = argv.lastIndexOf("serve");
  if (serveIndex < 0) return [];
  return argv.slice(serveIndex);
}

function argvContractOf(
  deps: Required<HostSharedObserverDeps>,
  argv: readonly string[],
  port: number,
): "v1" | "v2" | "none" | "ambiguous" {
  const serveIndex = argv.lastIndexOf("serve");
  if (serveIndex < 1) return "none";
  if (basename(argv[serveIndex - 1]) !== deps.executableBasename) return "none";
  const tail = argv.slice(serveIndex);
  const matches: Array<"v1" | "v2"> = [];
  for (const generation of ["v1", "v2"] as const) {
    const expected = deps.serveArgsFor(generation, LOOPBACK_HOST, port);
    if (tail.length === expected.length && tail.every((arg, i) => arg === expected[i])) {
      matches.push(generation);
    }
  }
  if (matches.length === 1) return matches[0];
  // 0 matches: an unknown shape. 2 matches: the upstream contract itself no
  // longer distinguishes them — either way this is a diagnostic, not a verdict.
  return matches.length === 0 ? "none" : "ambiguous";
}

/** LISTEN socket inodes for 127.0.0.1:<port> in this netns. */
function listenInodes(readProcFile: (p: string) => string, port: number): string[] | "permission_denied" {
  let table: string;
  try {
    table = readProcFile("/proc/net/tcp");
  } catch (error) {
    return errCode(error) === "EACCES" || errCode(error) === "EPERM" ? "permission_denied" : [];
  }
  const wanted = `${LOOPBACK_HEX}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[1] !== wanted || fields[3] !== TCP_LISTEN) continue;
    if (/^\d+$/.test(fields[9])) inodes.add(fields[9]);
  }
  return [...inodes];
}

/** The single pid whose fd table holds `socket:[inode]`. */
function socketOwnerPids(deps: Required<HostSharedObserverDeps>, inode: string): number[] | "permission_denied" {
  const target = `socket:[${inode}]`;
  let pids: string[];
  try {
    pids = deps.readDir("/proc");
  } catch {
    return "permission_denied";
  }
  let denied = false;
  const owners: number[] = [];
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1) continue;
    let fds: string[];
    try {
      fds = deps.readDir(`/proc/${pid}/fd`);
    } catch (error) {
      const code = errCode(error);
      if (code === "EACCES" || code === "EPERM") denied = true;
      continue;
    }
    for (const fd of fds) {
      try {
        if (deps.readLink(`/proc/${pid}/fd/${fd}`) === target) {
          owners.push(pid);
          break;
        }
      } catch (error) {
        const code = errCode(error);
        if (code === "EACCES" || code === "EPERM") denied = true;
      }
    }
  }
  if (owners.length > 0) return owners;
  return denied ? "permission_denied" : [];
}

interface Snapshot {
  inode: string;
  pid: number;
  uid: number;
  ticks: string;
}

/** One full locate pass. */
function locate(
  deps: Required<HostSharedObserverDeps>,
  port: number,
): { ok: true; snapshot: Snapshot } | { ok: false; reason: HostSharedObserveReason } {
  const inodes = listenInodes(deps.readProcFile, port);
  if (inodes === "permission_denied") return { ok: false, reason: "permission_denied" };
  if (inodes.length === 0) return { ok: false, reason: "no_listener" };
  // More than one LISTEN inode on the same loopback port: we cannot say which
  // one the caller means, and guessing is exactly what must not happen.
  if (inodes.length > 1) return { ok: false, reason: "ambiguous_listener" };
  const inode = inodes[0];
  const owners = socketOwnerPids(deps, inode);
  if (owners === "permission_denied") return { ok: false, reason: "permission_denied" };
  if (owners.length === 0) return { ok: false, reason: "socket_owner_not_found" };
  if (owners.length > 1) return { ok: false, reason: "ambiguous_listener" };
  const pid = owners[0];
  const uid = deps.procUid(pid);
  if (uid === undefined) return { ok: false, reason: "identity_mismatch" };
  const proc = deps.liveProcess(pid);
  if (!proc) return { ok: false, reason: "identity_mismatch" };
  return { ok: true, snapshot: { inode, pid, uid, ticks: proc.ticks } };
}

/**
 * Observe the real process behind a validated literal loopback URL.
 *
 * Read-only, never throws: every failure is a `reason`. Identity
 * (inode/pid/uid/startTicks) is read twice and must be identical, so a process
 * that died, was replaced, or whose PID was reused between the reads is a
 * failure rather than a stale success. Argv/executable are diagnostics and are
 * never returned as a proven generation.
 */
export function observeHostSharedServe(
  url: string,
  overrides: HostSharedObserverDeps = {},
): HostSharedObserveResult {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    if (deps.platform !== "linux") return { ok: false, reason: "unsupported_platform" };
    const parsed = parseLoopbackUrl(url);
    if (!parsed) return { ok: false, reason: "url_not_supported" };
    const { port } = parsed;

    const first = locate(deps, port);
    if (!first.ok) return first;

    let argv: string[] = [];
    let argvReadable = true;
    try {
      argv = deps.readProcFile(`/proc/${first.snapshot.pid}/cmdline`).split("\0").filter((a) => a !== "");
    } catch (error) {
      const code = errCode(error);
      if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "permission_denied" };
      argvReadable = false;
    }
    let executable: string | null = null;
    try {
      executable = deps.readLink(`/proc/${first.snapshot.pid}/exe`);
    } catch {
      executable = argvReadable && argv.length > 0 ? argv[0] : null;
    }

    // Re-verify the SAME process before returning: inode, pid, uid and start
    // ticks must all still be the ones we located.
    const second = locate(deps, port);
    if (!second.ok) return second;
    const a = first.snapshot, b = second.snapshot;
    if (a.inode !== b.inode || a.pid !== b.pid || a.uid !== b.uid || a.ticks !== b.ticks) {
      return { ok: false, reason: "identity_mismatch" };
    }

    return {
      ok: true,
      processEvidence: {
        url,
        host: LOOPBACK_HOST,
        port,
        listenInode: a.inode,
        pid: a.pid,
        uid: a.uid,
        startTicks: Number(a.ticks),
        diagnostics: {
          executable,
          argvTail: argvTailOf(argv),
          argvContract: argvReadable ? argvContractOf(deps, argv, port) : "none",
          argvContractNote: CONTRACT_NOTE,
        },
      },
    };
  } catch {
    // A pure observation must never escape as a throw.
    return { ok: false, reason: "identity_mismatch" };
  }
}

/** Literal `http://127.0.0.1:<port>` only — the sole shape this provider observes. */
export function parseLoopbackUrl(url: unknown): { port: number } | undefined {
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.hostname !== LOOPBACK_HOST) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined;
  return { port };
}

/**
 * A real liveness re-check bound to the exact pid+startTicks pair, so PID reuse
 * cannot pass. Exported so a consumer never re-implements it.
 */
export function makeHostSharedAliveProbe(
  overrides: HostSharedObserverDeps = {},
): (pid: number, startTicks: number) => boolean {
  const deps = { ...defaultDeps(), ...overrides };
  return (pid, startTicks) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    if (typeof startTicks !== "number" || !Number.isFinite(startTicks)) return false;
    try {
      const proc = deps.liveProcess(pid);
      return !!proc && proc.ticks === String(startTicks);
    } catch {
      return false;
    }
  };
}
