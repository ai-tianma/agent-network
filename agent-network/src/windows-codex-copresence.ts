import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { atomicWritePrivateJson, ensurePrivateDirectory } from "./private-state";

export type WindowsCopresenceRole = "appsrv" | "bridge";

export interface WindowsManagedProcess {
  role: WindowsCopresenceRole;
  pid: number;
  creationDate: string;
  logPath: string;
}

export interface WindowsCopresenceRecord {
  version: 1 | 2;
  nodeId: string;
  createdAt: string;
  marker?: string;
  processes: WindowsManagedProcess[];
}

export function windowsCopresenceRecordPath(nodesDir: string, nodeId: string): string {
  return join(nodesDir, nodeId, "windows-copresence.json");
}

export function windowsCopresenceLogPath(nodesDir: string, nodeId: string, role: WindowsCopresenceRole): string {
  return join(nodesDir, nodeId, `windows-${role}.log`);
}

export function openPrivateAppendLog(path: string): number {
  return openSync(path, "a", 0o600);
}

/** Protect credential-bearing state with native Windows ACLs. */
export function ensureWindowsPrivateDirectory(path: string): void {
  ensurePrivateDirectory(path);
}

export function closeLog(fd: number): void {
  closeSync(fd);
}

export type CreationDateProbe = (pid: number) => string | null;

/** Uses CIM instead of locale-dependent tasklist output. */
export function probeWindowsCreationDate(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const script = `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return out || null;
  } catch { return null; }
}

/**
 * Attribute an ESTABLISHED loopback connection to the launched TUI process
 * tree. This is deliberately stronger than counting listeners/connections:
 * an unrelated local client cannot satisfy it.
 */
export function probeWindowsOwnedLoopbackConnection(
  rootPid: number,
  expectedCreationDate: string,
  port: number,
  runPowerShell: (script: string) => string = (script) => execFileSync(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  ),
): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !/^\d+$/.test(expectedCreationDate)
    || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const script = [
      `$birth='${expectedCreationDate}'`,
      `$before=try{[Diagnostics.Process]::GetProcessById(${rootPid}).StartTime.ToUniversalTime().Ticks.ToString()}catch{''}`,
      "if($before-ne$birth){'false';exit 0}",
      `$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPid})`,
      // 🔴 #1342 —— 整张进程表**只枚举一次**,提到闭包循环之外。
      //
      //    原先 `Get-CimInstance Win32_Process` 写在 `do{…}while` **里面**,
      //    于是每一轮都重新枚举一次整张进程表(至少 2 轮:一轮找到子孙、
      //    一轮确认不再增长)。这是这次探测的主要成本。
      //
      //    实测(2026-08-31,main @ 82820594 的一次真实失败,由 #1628 加的
      //    `probeMs` 量到):**单次探测 9963ms,占 `waited=10363ms` 的 96%**,
      //    而那一跑的 job 本身只用了 106 秒 —— **不是机器慢,是这次调用本来就慢**。
      //    按 ~10 秒/次,`TUI_HEALTH_MS = 25_000` 实际只够 2 次多一点的探测,
      //    而调用方按 400ms 间隔写的循环期望的是几十次。
      //
      //    ⚠️ 语义上有一处**有意的**改变:原先每轮重读进程表,因此循环期间
      //    **新产生**的子孙会被看见;现在用的是一份快照。对这个用途这是更好的
      //    性质 —— 它是一次**归属判定**,一份一致的快照比跨轮拼接的视图更难被
      //    时序戏弄(root 的身份本来就由前后两次 birth 校验夹住)。
      "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId",
      "do{$n=0;$procs|%{if($ids.Contains([int]$_.ParentProcessId)-and $ids.Add([int]$_.ProcessId)){$n++}}}while($n-gt 0)",
      `$hit=Get-NetTCPConnection -State Established -RemoteAddress 127.0.0.1 -RemotePort ${port} -ErrorAction SilentlyContinue|?{$ids.Contains([int]$_.OwningProcess)}`,
      `$after=try{[Diagnostics.Process]::GetProcessById(${rootPid}).StartTime.ToUniversalTime().Ticks.ToString()}catch{''}`,
      "if($hit-and$after-eq$birth){'true'}else{'false'}",
    ].join(";");
    return runPowerShell(script).trim() === "true";
  } catch { return false; }
}

/**
 * #1342 —— 只在健康检查**即将失败**时跑一次,用来回答一个此前没人量过的问题:
 * 那 10.5 秒到底花在 **PowerShell 启动**上,还是花在 `Get-CimInstance Win32_Process`
 * 这个全表查询上?
 *
 * 实测背景(由 #1628/#1637 加的 probeMs 量到,2026-08-31):
 *   probes=1  waited=10897ms  probeMsLast=10490   ← 单次探测吃掉 96% 的预算
 * 而 #1636 把全表枚举提到循环外之后这个数**没有变小**(9963 → 10490),
 * 说明成本不在"重复枚举",而在那一次调用本身。但"那一次调用"包含两段:
 * 起一个 powershell 进程,和在里面跑 CIM 查询。**这两段要查的东西完全不同** ——
 * 前者是 runner/镜像的问题,后者是查询写法的问题。
 *
 * 🔴 这里跑的是一个**什么都不做**的脚本(`'x'`),所以它测到的就是启动那一段的下界。
 *    只在失败路径调用一次,不进探测循环 —— 不给正常路径增加任何成本,
 *    也**不可能**改变探测的返回值。
 *
 * 拿不到就返回 null(未知),不返回 0 —— 0 会被读成「启动不花时间」。
 */
export function measurePowerShellStartupMs(): number | null {
  try {
    const t0 = Date.now();
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "'x'"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export function writeWindowsCopresenceRecord(
  nodesDir: string,
  nodeId: string,
  processes: WindowsManagedProcess[],
  marker?: string,
): void {
  atomicWritePrivateJson(windowsCopresenceRecordPath(nodesDir, nodeId), {
    version: marker ? 2 : 1,
    nodeId,
    createdAt: new Date().toISOString(),
    ...(marker ? { marker } : {}),
    processes,
  } satisfies WindowsCopresenceRecord);
}

export function readWindowsCopresenceRecord(nodesDir: string, nodeId: string): WindowsCopresenceRecord | null {
  const path = windowsCopresenceRecordPath(nodesDir, nodeId);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowsCopresenceRecord>;
  if (![1, 2].includes(value.version as number) || value.nodeId !== nodeId || !Array.isArray(value.processes)
    || (value.version === 2 && (typeof value.marker !== "string" || !value.marker))) {
    throw new Error(`invalid Windows co-presence record: ${path}`);
  }
  for (const p of value.processes) {
    if (!p || !["appsrv", "bridge"].includes(p.role) || !Number.isInteger(p.pid) || p.pid <= 0
      || typeof p.creationDate !== "string" || !p.creationDate || typeof p.logPath !== "string") {
      throw new Error(`invalid managed process in Windows co-presence record: ${path}`);
    }
  }
  return value as WindowsCopresenceRecord;
}

export interface WindowsStopDecision {
  safe: WindowsManagedProcess[];
  refused: Array<{ process: WindowsManagedProcess; reason: "missing" | "pid-reused" }>;
}

/** PID alone is never authority: Windows reuses PIDs, so CreationDate must match. */
export function decideWindowsManagedStop(record: WindowsCopresenceRecord, probe: CreationDateProbe): WindowsStopDecision {
  const safe: WindowsManagedProcess[] = [];
  const refused: WindowsStopDecision["refused"] = [];
  for (const process of record.processes) {
    const current = probe(process.pid);
    if (!current) refused.push({ process, reason: "missing" });
    else if (current !== process.creationDate) refused.push({ process, reason: "pid-reused" });
    else safe.push(process);
  }
  return { safe, refused };
}

export function taskkillWindowsProcessTree(pid: number): void {
  const outcome = runTaskkillWindowsProcessTree(pid);
  if (outcome.status === 0) return;
  const detail = [
    outcome.status !== null ? `status=${outcome.status}` : null,
    outcome.signal ? `signal=${outcome.signal}` : null,
    outcome.stderrSummary ? `stderr=${outcome.stderrSummary}` : null,
    outcome.stderrDroppedBytes > 0 ? `stderrOmitted=${outcome.stderrDroppedBytes}B` : null,
  ].filter(Boolean).join(" ");
  throw new Error(`taskkill.exe /PID ${pid} /T /F did not report success${detail ? ` (${detail})` : ""}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1335 —— taskkill 非零之后：保留诊断，按**精确身份**裁决 gone / alive / unknown
//
// 现场（run 38587525619 / job 115933379757）：`taskkill.exe /PID 8100 /T /F` 非零，
// 自报原因 `Reason: There is no running instance of the task.`（PID 8744、7656 两个
// **后代**）——被枚举到的后代在终止前已退出。那只证明**那一次命令的报告**，**不能**推定
// 所有受管身份都已退出，也不同于同 stage 的 `The operation attempted is not supported`。
//
// 旧代码把 taskkill **退出码**放在身份判据之前（非零即 exit(1)），使按 PID+CreationDate
// 的残留判据不可达，良性竞态被当成硬失败。本段：① 非零保留 status/signal 与**受控** stderr
// 摘要；② 用**可区分**的身份查询判 gone/alive/unknown；③ 由 ② 裁决 —— **不**解析本地化
// 文案，也**不**按 PID 裸杀。
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskkillOutcome {
  status: number | null;
  signal: string | null;
  /** 受控摘要：仅保留 taskkill 自身固定形状的行，≤4 行 / 400 字符。 */
  stderrSummary: string;
  /** 被丢弃的 stderr 字节数——保留「有输出但形状不识别」这一事实，不泄露文本。 */
  stderrDroppedBytes: number;
}

const TASKKILL_STDERR_SHAPE = /^(ERROR|SUCCESS|INFO|Reason):[^\n]{0,160}$/;

/** 受控诊断：只放行已知形状（`ERROR:` / `Reason:` …），其余只记字节数。 */
export function summarizeTaskkillStderr(raw: string): { summary: string; droppedBytes: number } {
  const lines = String(raw ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept: string[] = [];
  let droppedBytes = 0;
  for (const line of lines) {
    const printable = line.replace(/[\u0000-\u001f\u007f]/g, "");
    if (kept.length < 4 && TASKKILL_STDERR_SHAPE.test(printable)) kept.push(printable);
    else droppedBytes += Buffer.byteLength(line, "utf8");
  }
  return { summary: kept.join(" | ").slice(0, 400), droppedBytes };
}

/** 非零**不再**丢弃诊断：拿回 status/signal 与受控 stderr，交给身份裁决。 */
export function runTaskkillWindowsProcessTree(pid: number): TaskkillOutcome {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000,
  });
  const { summary, droppedBytes } = summarizeTaskkillStderr(String(result.stderr ?? ""));
  return {
    status: typeof result.status === "number" ? result.status : null,
    signal: (result.signal as string | null) ?? null,
    stderrSummary: summary,
    stderrDroppedBytes: droppedBytes,
  };
}

export type WindowsIdentityState = "alive" | "gone" | "pid-reused" | "unknown";

/** 结构化协议：判定只读这个协议，**不**读本地化的错误文案。 */
export const WINDOWS_IDENTITY_PROTOCOL = "IDSTATE:";

/** gone 用 .NET 的 `ArgumentException`（进程不存在）辨认——**异常类型**不随语言变化。 */
export function windowsIdentityProbeScript(pid: number): string {
  return [
    "$ErrorActionPreference='Stop'",
    "try{",
    `$p=[Diagnostics.Process]::GetProcessById(${pid})`,
    "$t=$p.StartTime.ToUniversalTime().Ticks.ToString()",
    `'${WINDOWS_IDENTITY_PROTOCOL}TICKS='+$t`,
    `}catch [System.ArgumentException]{'${WINDOWS_IDENTITY_PROTOCOL}ABSENT'}catch{'${WINDOWS_IDENTITY_PROTOCOL}ERROR'}`,
  ].join(";");
}

export type WindowsIdentityRead = { kind: "ticks"; ticks: string } | { kind: "absent" } | { kind: "unknown" };

function defaultPowerShellRunner(script: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15_000,
  });
}

/** 空输出 / 多行 / 非法形状 / 异常 ⇒ unknown（**不能**折成 gone）。 */
export function readWindowsIdentity(pid: number, runPowerShell: (script: string) => string = defaultPowerShellRunner): WindowsIdentityRead {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "unknown" };
  try {
    const out = String(runPowerShell(windowsIdentityProbeScript(pid)) ?? "").trim();
    if (out === `${WINDOWS_IDENTITY_PROTOCOL}ABSENT`) return { kind: "absent" };
    const matched = new RegExp(`^${WINDOWS_IDENTITY_PROTOCOL}TICKS=(\\d+)$`).exec(out);
    return matched ? { kind: "ticks", ticks: matched[1] } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

/** 三向：alive(出生身份仍在) / gone(该身份已不存在) / pid-reused(同 PID 已被无关进程占用) / unknown。 */
export function probeWindowsIdentity(
  pid: number,
  expectedCreationDate: string,
  runPowerShell: (script: string) => string = defaultPowerShellRunner,
): WindowsIdentityState {
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d+$/.test(expectedCreationDate)) return "unknown";
  const read = readWindowsIdentity(pid, runPowerShell);
  if (read.kind === "absent") return "gone";
  if (read.kind === "ticks") return read.ticks === expectedCreationDate ? "alive" : "pid-reused";
  return "unknown";
}

export interface WindowsManagedIdentity {
  role: string;
  pid: number;
  creationDate: string;
}

/** 单次 CIM 枚举（同 `probeWindowsOwnedLoopbackConnection` 手法）；**只**用于取证，不用于杀进程。 */
export function windowsDescendantEnumerationScript(rootPid: number): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId",
    `$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPid})`,
    "do{$n=0;$procs|%{if($ids.Contains([int]$_.ParentProcessId)-and $ids.Add([int]$_.ProcessId)){$n++}}}while($n-gt 0)",
    `[void]$ids.Remove(${rootPid})`,
    "'DESC:'+($ids-join',')",
  ].join(";");
}

export function parseWindowsDescendantPids(raw: string): number[] | null {
  const matched = /^DESC:(\d+(,\d+)*)?$/.exec(String(raw ?? "").trim());
  if (!matched) return null;
  if (!matched[1]) return [];
  const pids = matched[1].split(",").map(Number);
  return pids.every((pid) => Number.isInteger(pid) && pid > 0) ? pids : null;
}

export interface WindowsDescendantCapture {
  identities: WindowsManagedIdentity[];
  /** 非空 ⇒ 取证不完整，调用方**必须**按 unknown 处理，不得当成功。 */
  unknownReason?: string;
}

/**
 * 终止前**现取**后代出生身份：记录里只有 appsrv/bridge，**没有**后代。拿不到 ⇒
 * unknownReason（不猜）。只用于**验证**；杀进程仍走根 PID 的既存出生身份。
 */
export function captureWindowsDescendantIdentities(
  rootRole: string,
  rootPid: number,
  opts: { cap?: number; runPowerShell?: (script: string) => string } = {},
): WindowsDescendantCapture {
  const cap = opts.cap ?? 16;
  const run = opts.runPowerShell ?? defaultPowerShellRunner;
  let pids: number[] | null = null;
  try { pids = parseWindowsDescendantPids(run(windowsDescendantEnumerationScript(rootPid))); }
  catch { return { identities: [], unknownReason: `descendant enumeration failed for ${rootRole} pid=${rootPid}` }; }
  if (!pids) return { identities: [], unknownReason: `descendant enumeration output not understood for ${rootRole} pid=${rootPid}` };
  if (pids.length > cap) return { identities: [], unknownReason: `descendant count ${pids.length} exceeds cap ${cap} for ${rootRole} pid=${rootPid}` };
  const identities: WindowsManagedIdentity[] = [];
  for (const pid of pids) {
    const read = readWindowsIdentity(pid, run);
    if (read.kind === "ticks") identities.push({ role: `${rootRole}:desc`, pid, creationDate: read.ticks });
    else if (read.kind === "unknown") return { identities, unknownReason: `descendant ${pid} of ${rootRole} pid=${rootPid} birth identity not queryable` };
    // absent：取证时已不存在，没有需要后续验证的身份。
  }
  return { identities };
}

export type WindowsStopVerdict =
  | { kind: "stopped"; retainedDiagnostics: string[] }
  | { kind: "survived"; alive: string[]; retainedDiagnostics: string[] }
  | { kind: "unverifiable"; unknown: string[]; retainedDiagnostics: string[] };

/**
 * 成败只由**精确身份**裁决（不解析 taskkill 文案）：任一 `alive` ⇒ survived；否则任一
 * `unknown`（含取证缺口）⇒ unverifiable（两者**都不得绿**）；全部 gone 或 pid-reused
 * ⇒ stopped，并把非零 taskkill 的 status/signal/受控 stderr 作为**保留诊断**带出。
 */
export function decideWindowsStopVerdict(opts: {
  identities: WindowsManagedIdentity[];
  kills: Array<{ label: string; outcome: TaskkillOutcome }>;
  probe: (identity: WindowsManagedIdentity) => WindowsIdentityState;
  captureUnknown?: string[];
}): WindowsStopVerdict {
  const retainedDiagnostics: string[] = [];
  for (const kill of opts.kills) {
    const { outcome } = kill;
    if (outcome.status === 0 && !outcome.signal) continue;
    retainedDiagnostics.push([
      `taskkill non-zero for ${kill.label}`,
      `status=${outcome.status === null ? "null" : outcome.status}`,
      `signal=${outcome.signal ?? "null"}`,
      outcome.stderrSummary ? `stderr=${outcome.stderrSummary}` : null,
      outcome.stderrDroppedBytes > 0 ? `stderrOmitted=${outcome.stderrDroppedBytes}B` : null,
    ].filter(Boolean).join(" "));
  }
  const alive: string[] = [];
  const unknown: string[] = [...(opts.captureUnknown ?? [])];
  for (const identity of opts.identities) {
    const state = opts.probe(identity);
    const label = `${identity.role} pid=${identity.pid}`;
    if (state === "alive") alive.push(label);
    else if (state === "unknown") unknown.push(label);
    else if (state === "pid-reused") retainedDiagnostics.push(`${label} pid reused; unrelated process left untouched`);
  }
  if (alive.length > 0) return { kind: "survived", alive, retainedDiagnostics };
  if (unknown.length > 0) return { kind: "unverifiable", unknown, retainedDiagnostics };
  return { kind: "stopped", retainedDiagnostics };
}
