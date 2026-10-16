import { describe, expect, test } from "bun:test";
import {
  captureWindowsDescendantIdentities, orchestrateWindowsManagedStop, parseWindowsCapture,
  probeWindowsIdentity, readWindowsIdentity, summarizeTaskkillStderr,
  type TaskkillOutcome, type WindowsIdentityState, type WindowsManagedIdentity,
} from "./windows-codex-copresence";

// #1335 见证。🔴 关键：正负见证走 **CLI 实际使用的那一份编排**
// （`orchestrateWindowsManagedStop`，注入 runner/executor），并**观测 kill 调用**；
// 纯协议解析的用例保留，但**不**当作 CLI/原生证据的替身。

const root: WindowsManagedIdentity = { role: "bridge", pid: 8100, creationDate: "999" };

// 现场 run 38587525619 / job 115933379757 的 taskkill stderr 原文（两行 ERROR + 两行 Reason）。
// ⚠️ status 数值是**代表值**：现场日志保留了文案，未保留退出码。
const liveSampleStderr = [
  "ERROR: The process with PID 8744 (child process of PID 7656) could not be terminated.",
  "Reason: There is no running instance of the task.",
  "",
  "ERROR: The process with PID 7656 (child process of PID 8040) could not be terminated.",
  "Reason: There is no running instance of the task.",
].join("\r\n");

const { summary } = summarizeTaskkillStderr(liveSampleStderr);
const nonZeroKill = (pid: number): TaskkillOutcome => ({ status: 128, signal: null, stderrSummary: summary, stderrDroppedBytes: 0 });

/** 脚本化环境：按「脚本形状」路由响应，并把**调用序列**记下来（控制流见证）。 */
function scriptedEnv(opts: { capture: string; probes: string[] }) {
  const calls: string[] = [];
  const killed: number[] = [];
  let probeIndex = 0;
  const runPowerShell = (script: string): string => {
    if (script.includes("CAP:RB=")) { calls.push("capture"); return opts.capture; }
    const pid = Number(/GetProcessById\((\d+)\)/.exec(script)![1]);
    calls.push(`probe:${pid}`);
    return opts.probes[probeIndex++];
  };
  const runTaskkill = (pid: number): TaskkillOutcome => { calls.push(`kill:${pid}`); killed.push(pid); return nonZeroKill(pid); };
  return { runPowerShell, runTaskkill, calls, killed };
}

describe("#1335 停止编排（CLI 共用实现）—— 正负见证", () => {
  test("正向：非零 taskkill + 原身份（含已捕获后代）均已 gone ⇒ stopped，且诊断保留", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=999;D=8744=777;G=",
      // 顺序 = 终止紧前重验根 → 裁决期再探 根、后代
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "IDSTATE:ABSENT"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");
    expect(stop.mustKeepRecord).toBe(false);
    expect(stop.killedPids).toEqual([8100]);
    expect(stop.identities.map((i) => i.pid)).toEqual([8100, 8744]);
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("status=128");
    expect(diagnostics).toContain("There is no running instance of the task.");
    // 控制流见证：终止之前**先**重验根身份，且只发一次终止命令。
    expect(env.calls).toEqual(["capture", "probe:8100", "kill:8100", "probe:8100", "probe:8744"]);
  });

  test("负控：根 gone 但**已捕获同身份后代 alive** ⇒ 必须非零，且**不发**终止命令", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=999;D=8744=777;G=",
      probes: ["IDSTATE:ABSENT", "IDSTATE:ABSENT", "IDSTATE:TICKS=777"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);
    expect(stop.verdict.kind).toBe("survived");
    expect(stop.verdict.kind === "survived" && stop.verdict.alive).toEqual(["bridge:desc pid=8744"]);
    expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("kill withheld for bridge pid=8100: root identity gone");
    expect(stop.mustKeepRecord).toBe(true);
  });

  test("负控：查询 unknown ⇒ 必须非零、保留记录、不通知离线", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=999;D=8744=777;G=",
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "garbage-not-a-protocol"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");
    expect(stop.verdict.kind === "unverifiable" && stop.verdict.unknown).toEqual(["bridge:desc pid=8744"]);
    expect(stop.mustKeepRecord).toBe(true);
  });

  test("负控：初检匹配→**取证期间根复用** ⇒ kill 调用为 0，无关身份不被触碰", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=888;D=;G=",               // 根在取证期间被复用（RA≠期望）
      probes: ["IDSTATE:TICKS=888", "IDSTATE:TICKS=888"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);                     // 🔴 观测到 kill 调用为 0
    expect(stop.verdict.kind).toBe("unverifiable");
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("root identity changed during capture");
    expect(diagnostics).toContain("pid reused; unrelated process left untouched");
  });

  test("分辨力：同一场景只把后代探针 gone 翻成 alive ⇒ 裁决翻转", () => {
    const gone = scriptedEnv({ capture: "CAP:RB=999;RA=999;D=8744=777;G=", probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "IDSTATE:ABSENT"] });
    const alive = scriptedEnv({ capture: "CAP:RB=999;RA=999;D=8744=777;G=", probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "IDSTATE:TICKS=777"] });
    expect(orchestrateWindowsManagedStop([root], gone).verdict.kind).toBe("stopped");
    expect(orchestrateWindowsManagedStop([root], alive).verdict.kind).toBe("survived");
  });
});

describe("#1335 取证绑定根身份（同一枚举读后代出生身份 + 前后核根代际）", () => {
  const run = (out: string) => () => out;
  test("根代际漂移 ⇒ unknown（不猜），且不返回后代", () => {
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=888;RA=888;D=8744=777;G=") }).unknownReason).toContain("before capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=888;D=8744=777;G=") }).unknownReason).toContain("changed during capture");
  });
  test("后代出生身份在枚举中读不到（G 非空）⇒ unknown；超上限 ⇒ unknown；输出非法/抛错 ⇒ unknown", () => {
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=999;D=;G=8744") }).unknownReason).toContain("unreadable during capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=999;D=1=1,2=2,3=3;G="), cap: 2 }).unknownReason).toContain("exceeds cap");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("nonsense") }).unknownReason).toContain("not understood");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: () => { throw new Error("powershell missing"); } }).unknownReason).toContain("capture query failed");
  });
  test("合规取证：返回后代身份（出生身份来自同一枚举）", () => {
    const captured = captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=999;D=8744=777,7656=555;G=") });
    expect(captured.unknownReason).toBeUndefined();
    expect(captured.identities).toEqual([
      { role: "bridge:desc", pid: 8744, creationDate: "777" },
      { role: "bridge:desc", pid: 7656, creationDate: "555" },
    ]);
    expect(parseWindowsCapture("CAP:RB=999;RA=SKIP;D=;G=")).toEqual({ rootBefore: "999", rootAfter: "SKIP", descendants: [], gaps: [] });
  });
});

describe("#1335 身份协议与受控诊断（纯函数，非 CLI/原生证据替身）", () => {
  const p = "IDSTATE:";
  test("ABSENT⇒gone / TICKS 相同⇒alive / 不同⇒pid-reused / 空·多行·非法·抛错⇒unknown；stderr 受控", () => {
    expect(probeWindowsIdentity(8100, "999", () => `${p}ABSENT`)).toBe("gone");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=999`)).toBe("alive");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=888`)).toBe("pid-reused");
    for (const bad of ["", `${p}TICKS=999\nnoise`, "not-a-protocol"]) expect(probeWindowsIdentity(8100, "999", () => bad)).toBe("unknown");
    expect(probeWindowsIdentity(8100, "999", () => { throw new Error("access denied"); })).toBe("unknown");
    expect(readWindowsIdentity(8100, () => `${p}ABSENT`)).toEqual({ kind: "absent" });
    const { summary: kept, droppedBytes } = summarizeTaskkillStderr(`${liveSampleStderr}\r\nunshaped-line-with=secret`);
    expect(kept).toContain("ERROR: The process with PID 8744");
    expect(kept).not.toContain("secret");
    expect(droppedBytes).toBeGreaterThan(0);
  });
});
