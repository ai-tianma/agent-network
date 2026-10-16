import { describe, expect, test } from "bun:test";
import {
  captureWindowsDescendantIdentities, decideWindowsStopVerdict, parseWindowsDescendantPids,
  probeWindowsIdentity, readWindowsIdentity, summarizeTaskkillStderr,
  type TaskkillOutcome, type WindowsIdentityState, type WindowsManagedIdentity,
} from "./windows-codex-copresence";

// #1335 的见证：taskkill 非零**之后**，成败只由精确身份（PID + CreationDate）裁决。
// 正负见证必须互相有分辨力 —— 同一场景只翻转一个探针结果，裁决必须翻转。

const root: WindowsManagedIdentity = { role: "bridge", pid: 8100, creationDate: "639000000000000000" };
const descendant: WindowsManagedIdentity = { role: "bridge:desc", pid: 8744, creationDate: "639000000000000100" };

// 现场 run 38587525619 / job 115933379757 的 taskkill stderr 原文（两行 ERROR + 两行 Reason）。
// ⚠️ 数值 status 是**代表值**：现场日志保留了文案，但没有保留退出码。
const liveSampleStderr = [
  "ERROR: The process with PID 8744 (child process of PID 7656) could not be terminated.",
  "Reason: There is no running instance of the task.",
  "",
  "ERROR: The process with PID 7656 (child process of PID 8040) could not be terminated.",
  "Reason: There is no running instance of the task.",
].join("\r\n");

const nonZero = (label: string): { label: string; outcome: TaskkillOutcome } => {
  const { summary, droppedBytes } = summarizeTaskkillStderr(liveSampleStderr);
  return { label, outcome: { status: 128, signal: null, stderrSummary: summary, stderrDroppedBytes: droppedBytes } };
};

const verdict = (
  identities: WindowsManagedIdentity[],
  states: WindowsIdentityState[],
  extra: { captureUnknown?: string[] } = {},
) => decideWindowsStopVerdict({
  identities,
  kills: [nonZero("bridge pid=8100")],
  probe: (() => { let i = 0; return () => states[i++]; })(),
  ...extra,
});

describe("#1335 taskkill 非零后的精确身份裁决", () => {
  test("正向：非零 + 所有原身份已退出 ⇒ 成功，且**保留**原始 status / 受控 stderr 诊断", () => {
    const v = verdict([root, descendant], ["gone", "gone"]);
    expect(v.kind).toBe("stopped");
    expect(v.retainedDiagnostics.length).toBeGreaterThan(0);
    const diagnostic = v.retainedDiagnostics.join("\n");
    expect(diagnostic).toContain("taskkill non-zero for bridge pid=8100");
    expect(diagnostic).toContain("status=128");
    expect(diagnostic).toContain("There is no running instance of the task.");
  });

  test("分辨力：同一场景只把探针从 gone 翻成 alive ⇒ 必须变成 survived（不得绿）", () => {
    expect(verdict([root], ["gone"]).kind).toBe("stopped");
    expect(verdict([root], ["alive"]).kind).toBe("survived");
  });

  test("负控：**已捕获的后代**仍存活也必须失败（不能只证明根退出）", () => {
    const v = verdict([root, descendant], ["gone", "alive"]);
    expect(v.kind).toBe("survived");
    expect(v.kind === "survived" && v.alive).toEqual(["bridge:desc pid=8744"]);
  });

  test("负控：查询 unknown（权限拒绝/超时/非法输出）不得绿 ⇒ unverifiable", () => {
    const v = verdict([root, descendant], ["gone", "unknown"]);
    expect(v.kind).toBe("unverifiable");
    expect(v.kind === "unverifiable" && v.unknown).toEqual(["bridge:desc pid=8744"]);
    expect(v.kind).not.toBe("stopped");
  });

  test("负控：取证缺口（后代出生身份取不到）不得绿 ⇒ unverifiable", () => {
    const v = verdict([root], ["gone"], { captureUnknown: ["descendant enumeration failed for bridge pid=8100"] });
    expect(v.kind).toBe("unverifiable");
  });

  test("PID 复用：该身份视为已退出、**不触碰**无关进程，且留下告警", () => {
    const v = verdict([root], ["pid-reused"]);
    expect(v.kind).toBe("stopped");
    expect(v.retainedDiagnostics.join("\n")).toContain("pid reused; unrelated process left untouched");
    // 复用与存活同时存在时，存活优先 ⇒ 仍失败。
    expect(verdict([root, descendant], ["pid-reused", "alive"]).kind).toBe("survived");
  });

  test("受控 stderr：已知形状保留，形状不识别只记字节数（不泄露文本）", () => {
    const { summary, droppedBytes } = summarizeTaskkillStderr(`${liveSampleStderr}\r\nsome-unshaped-line-with=secret`);
    expect(summary).toContain("ERROR: The process with PID 8744");
    expect(summary).toContain("Reason: There is no running instance of the task.");
    expect(summary).not.toContain("secret");
    expect(droppedBytes).toBeGreaterThan(0);
  });
});

describe("#1335 身份查询协议（不解析本地化文案）", () => {
  const script = "IDSTATE:";
  test("ABSENT ⇒ gone；TICKS 相同 ⇒ alive；TICKS 不同 ⇒ pid-reused", () => {
    expect(probeWindowsIdentity(8100, "639", () => `${script}ABSENT`)).toBe("gone");
    expect(probeWindowsIdentity(8100, "639", () => `${script}TICKS=639`)).toBe("alive");
    expect(probeWindowsIdentity(8100, "639", () => `${script}TICKS=640`)).toBe("pid-reused");
  });

  test("空输出 / 多行 / 非法形状 / 抛错 / 非法入参 ⇒ unknown（**不折成 gone**）", () => {
    expect(probeWindowsIdentity(8100, "639", () => "")).toBe("unknown");
    expect(probeWindowsIdentity(8100, "639", () => `${script}TICKS=639\nnoise`)).toBe("unknown");
    expect(probeWindowsIdentity(8100, "639", () => "ERROR: not a protocol")).toBe("unknown");
    expect(probeWindowsIdentity(8100, "639", () => { throw new Error("access denied"); })).toBe("unknown");
    expect(probeWindowsIdentity(0, "639", () => `${script}TICKS=639`)).toBe("unknown");
    expect(probeWindowsIdentity(8100, "not-a-tick", () => `${script}TICKS=639`)).toBe("unknown");
  });

  test("readWindowsIdentity 区分 ticks / absent / unknown", () => {
    expect(readWindowsIdentity(8100, () => `${script}TICKS=639`)).toEqual({ kind: "ticks", ticks: "639" });
    expect(readWindowsIdentity(8100, () => `${script}ABSENT`)).toEqual({ kind: "absent" });
    expect(readWindowsIdentity(8100, () => "garbage")).toEqual({ kind: "unknown" });
  });

  test("后代枚举输出解析：合法 / 空 / 垃圾", () => {
    expect(parseWindowsDescendantPids("DESC:8744,7656")).toEqual([8744, 7656]);
    expect(parseWindowsDescendantPids("DESC:")).toEqual([]);
    expect(parseWindowsDescendantPids("DESC:abc")).toBeNull();
    expect(parseWindowsDescendantPids("ERROR: something")).toBeNull();
    expect(parseWindowsDescendantPids("")).toBeNull();
  });

  test("后代取证：取到出生身份 / 空列表 / 垃圾输出 / 超上限 / 出生身份不可查 ⇒ 缺口", () => {
    const captured = captureWindowsDescendantIdentities("bridge", 8100, {
      runPowerShell: (s) => (s.includes("DESC:") ? "DESC:8744,7656" : `${script}TICKS=639000000000000${s.match(/GetProcessById\((\d+)\)/)![1]}`),
    });
    expect(captured.unknownReason).toBeUndefined();
    expect(captured.identities.map((i) => i.pid)).toEqual([8744, 7656]);
    expect(captured.identities.every((i) => i.role === "bridge:desc")).toBe(true);

    expect(captureWindowsDescendantIdentities("bridge", 8100, { runPowerShell: () => "DESC:" }).identities).toEqual([]);
    expect(captureWindowsDescendantIdentities("bridge", 8100, { runPowerShell: () => "nonsense" }).unknownReason).toContain("not understood");
    expect(captureWindowsDescendantIdentities("bridge", 8100, { runPowerShell: (s) => (s.includes("DESC:") ? "DESC:1,2,3" : `${script}TICKS=1`), cap: 2 }).unknownReason).toContain("exceeds cap");
    expect(captureWindowsDescendantIdentities("bridge", 8100, { runPowerShell: (s) => (s.includes("DESC:") ? "DESC:8744" : "unreadable") }).unknownReason).toContain("not queryable");
    expect(captureWindowsDescendantIdentities("bridge", 8100, { runPowerShell: () => { throw new Error("powershell missing"); } }).unknownReason).toContain("enumeration failed");
  });
});
