import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  captureWindowsDescendantIdentities, orchestrateWindowsManagedStop, parseWindowsCapture, windowsCaptureScript,
  probeWindowsIdentity, readWindowsIdentity, summarizeTaskkillStderr,
  type TaskkillOutcome, type WindowsIdentityState, type WindowsManagedIdentity,
} from "./windows-codex-copresence";

// #1335 见证。🔴 正负见证走 **CLI 实际使用的那一份编排**
// （`orchestrateWindowsManagedStop`，注入 runner/executor）并**观测 kill 调用**。
// 🔴 身份协议**分两种、不混用**：根 = .NET ticks；**后代 = 同一份 CIM 枚举快照里的 CreationDate**。

const root: WindowsManagedIdentity = { role: "bridge", pid: 8100, creationDate: "999" };
const DESC_BIRTH = "2026-10-16T02:41:37.1234560+00:00";
const OTHER_BIRTH = "2026-10-16T09:00:00.0000000+00:00";
const cap = (desc: string) => `CAP:RB=999;RA=999;D=${desc};G=`;

// 现场 run 38587525619 / job 115933379757 的 taskkill stderr 原文。status 数值是**代表值**。
const liveSampleStderr = [
  "ERROR: The process with PID 8744 (child process of PID 7656) could not be terminated.",
  "Reason: There is no running instance of the task.",
  "",
  "ERROR: The process with PID 7656 (child process of PID 8040) could not be terminated.",
  "Reason: There is no running instance of the task.",
].join("\r\n");
const { summary } = summarizeTaskkillStderr(liveSampleStderr);
const nonZeroKill = (): TaskkillOutcome => ({ status: 128, signal: null, stderrSummary: summary, stderrDroppedBytes: 0 });

/** 脚本化环境：按脚本形状路由，并记录**调用序列**与 kill 调用（控制流见证）。 */
function scriptedEnv(opts: { capture: string; probes: string[] }) {
  const calls: string[] = [];
  const killed: number[] = [];
  let probeIndex = 0;
  const runPowerShell = (script: string): string => {
    if (script.includes("CAP:RB=")) { calls.push("capture"); return opts.capture; }
    const pid = Number(/GetProcessById\((\d+)\)|ProcessId = (\d+)/.exec(script)!.slice(1).filter(Boolean)[0]);
    calls.push(`probe:${pid}`);
    return opts.probes[probeIndex++];
  };
  const runTaskkill = (pid: number): TaskkillOutcome => { calls.push(`kill:${pid}`); killed.push(pid); return nonZeroKill(); };
  return { runPowerShell, runTaskkill, calls, killed };
}

describe("#1335 停止编排（CLI 共用实现）—— 正负见证", () => {
  test("正向：非零 taskkill + 原身份（含已捕获后代）均已 gone ⇒ stopped，且诊断保留", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:ABSENT"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");
    expect(stop.mustKeepRecord).toBe(false);
    expect(stop.killedPids).toEqual([8100]);
    expect(stop.identities.map((i) => i.pid)).toEqual([8100, 8744]);
    expect(stop.identities[1].kind).toBe("creation");                     // 后代走 CIM 协议
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("status=128");
    expect(diagnostics).toContain("There is no running instance of the task.");
    // 控制流见证：终止之前**先**重验根身份，且只发一次终止命令。
    expect(env.calls).toEqual(["capture", "probe:8100", "kill:8100", "probe:8100", "probe:8744"]);
  });

  test("负控：根 gone 但**已捕获同身份后代 alive** ⇒ 非零，且**不发**终止命令", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:ABSENT", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${DESC_BIRTH}`],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);
    expect(stop.verdict.kind).toBe("survived");
    expect(stop.verdict.kind === "survived" && stop.verdict.alive).toEqual(["bridge:desc pid=8744"]);
    expect(stop.mustKeepRecord).toBe(true);
  });

  test("负控：后代 PID 被**无关进程复用**（出生身份变化）⇒ 视为已退出，不报残留、不触碰无关身份", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${OTHER_BIRTH}`],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");                            // 不是 survived
    expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("pid reused; unrelated process left untouched");
  });

  test("（编排层）查询 unknown ⇒ verdict 非零且 mustKeepRecord=true —— **未验** CLI 退出码/记录文件/离线通知", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "garbage-not-a-protocol"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");
    expect(stop.mustKeepRecord).toBe(true);
    // 🔴 本条**只**断言编排层的 verdict 与布尔；CLI 是否真的保留记录、是否真的没通知离线 = **未验**（见下条结构见证）。
  });

  test("负控：初检匹配→**取证期间根复用** ⇒ kill 调用为 0，无关身份不被触碰", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=888;D=;G=",
      probes: ["IDSTATE:TICKS=888", "IDSTATE:TICKS=888"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);
    expect(stop.verdict.kind).toBe("unverifiable");
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("root identity changed during capture");
    expect(diagnostics).toContain("pid reused; unrelated process left untouched");
  });

  test("（结构见证）CLI 停止入口在删记录/通知离线**之前**退出 —— 副作用本身仍为**未验**", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    const start = cli.indexOf("const stop = orchestrateWindowsManagedStop(");
    const rm = cli.indexOf("rmSync(windowsCopresenceRecordPath(", start);
    expect(start).toBeGreaterThan(0);
    expect(rm).toBeGreaterThan(start);
    const slice = cli.slice(start, rm);
    expect(slice).toContain("if (stop.verdict.kind === \"survived\")");
    expect(slice).toContain("if (stop.verdict.kind === \"unverifiable\")");
    expect(slice).toContain("if (stop.mustKeepRecord)");
    expect((slice.match(/process\.exit\(1\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // 🔴 未验：CLI 的**实际退出码**、记录文件是否仍在、是否**未**通知 Hub 离线 —— 需要隔离 CLI fixture 才能观察，
    //    本片**保留为未验项**，不把编排层布尔当作已发生的副作用证据。
  });
});

describe("#1335 取证：后代出生身份必须来自**同一份枚举快照**", () => {
  test("（结构见证）快照同时给出父子关系与出生身份；后代不再二次读取", () => {
    const script = windowsCaptureScript(8100, "999");
    expect(script).toContain("Select-Object ProcessId,ParentProcessId,CreationDate");
    expect(script).toContain("$hit=$procs|?{[int]$_.ProcessId -eq $id}");
    expect(script).toContain("$hit.CreationDate.ToString('o')");
    // 旧形态（枚举 PID → 再逐 PID 读出生身份）必须**不再出现**：正是复审指出的窗口。
    expect(script.includes("ReadBirthTicks $id")).toBe(false);
    // 根仍走未改动的 ticks 协议。
    expect(script).toContain("function ReadBirthTicks([int]$p)");
    expect(script).toContain("ReadBirthTicks 8100");
  });

  test("根代际漂移 ⇒ unknown（不猜），且不返回后代；出生身份读不到/超上限/非法/抛错 ⇒ unknown", () => {
    const run = (out: string) => () => out;
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=888;RA=888;D=;G=") }).unknownReason).toContain("before capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=888;D=;G=") }).unknownReason).toContain("changed during capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run(`CAP:RB=999;RA=999;D=;G=8744`) }).unknownReason).toContain("unreadable during capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run(cap("1=2026-10-16T02:41:37.1+00:00,2=2026-10-16T02:41:37.2+00:00,3=2026-10-16T02:41:37.3+00:00")), cap: 2 }).unknownReason).toContain("exceeds cap");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("nonsense") }).unknownReason).toContain("not understood");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: () => { throw new Error("powershell missing"); } }).unknownReason).toContain("capture query failed");
  });

  test("合规取证：后代身份带 kind=creation 且出生身份取自枚举", () => {
    const captured = captureWindowsDescendantIdentities(root, { runPowerShell: () => cap(`8744=${DESC_BIRTH},7656=2026-10-16T02:41:37.5555555+00:00`) });
    expect(captured.unknownReason).toBeUndefined();
    expect(captured.identities).toEqual([
      { role: "bridge:desc", pid: 8744, creationDate: DESC_BIRTH, kind: "creation" },
      { role: "bridge:desc", pid: 7656, creationDate: "2026-10-16T02:41:37.5555555+00:00", kind: "creation" },
    ]);
    expect(parseWindowsCapture("CAP:RB=999;RA=SKIP;D=;G=")).toEqual({ rootBefore: "999", rootAfter: "SKIP", descendants: [], gaps: [] });
  });
});

describe("#1335 身份协议与受控诊断（纯函数，非 CLI/原生证据替身）", () => {
  const p = "IDSTATE:";
  test("双协议各自精确相等：ticks（根）/ CIM CreationDate（后代）；缺省/非法一律 unknown", () => {
    expect(probeWindowsIdentity(8100, "999", () => `${p}ABSENT`)).toBe("gone");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=999`)).toBe("alive");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=888`)).toBe("pid-reused");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${DESC_BIRTH}`, "creation")).toBe("alive");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${OTHER_BIRTH}`, "creation")).toBe("pid-reused");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => "CIMSTATE:ABSENT", "creation")).toBe("gone");
    for (const bad of ["", `${p}TICKS=999\nnoise`, "not-a-protocol", "CIMSTATE:ERROR"]) {
      expect(probeWindowsIdentity(8100, "999", () => bad)).toBe("unknown");
    }
    expect(probeWindowsIdentity(8100, "999", () => { throw new Error("access denied"); })).toBe("unknown");
    expect(readWindowsIdentity(8100, () => `${p}ABSENT`)).toEqual({ kind: "absent" });
    const { summary: kept, droppedBytes } = summarizeTaskkillStderr(`${liveSampleStderr}\r\nunshaped-line-with=secret`);
    expect(kept).toContain("ERROR: The process with PID 8744");
    expect(kept).not.toContain("secret");
    expect(droppedBytes).toBeGreaterThan(0);
  });
});
