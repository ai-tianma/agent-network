// #1337 —— 纯测试夹具：`powershell.exe` 包装器（**只在具名测试模式**下改变行为）。
//
// 纪律（卡上要求）：
//   * 只作用于**该次 CLI 子进程**的私有 PATH；不替换系统文件、不改全局 PATH。
//   * 非具名模式一律**委托绝对路径真实程序**（`ANET_TEST1337_REAL_POWERSHELL`），保持其它探测真实。
//   * 每次调用都写**调用日志**（`ANET_TEST1337_PS_LOG`），用于证明"夹具确实被命中"，不靠假设。
//   * **只**拦新身份协议查询（含 `CIMSTATE:` 的那次）；旧 ownership 预检（GetProcessById/StartTime）继续走真实程序
//     —— 这样场景 C 不会被"更早的预检失败"冒充。
using System;
using System.Diagnostics;
using System.IO;

internal static class PowerShellShim
{
    private static int Main(string[] args)
    {
        string log = Environment.GetEnvironmentVariable("ANET_TEST1337_PS_LOG");
        string mode = Environment.GetEnvironmentVariable("ANET_TEST1337_PS_MODE") ?? "delegate";
        string real = Environment.GetEnvironmentVariable("ANET_TEST1337_REAL_POWERSHELL");
        string command = string.Join(" ", args);

        try
        {
            if (!string.IsNullOrEmpty(log))
                File.AppendAllText(log, mode + "\t" + command + Environment.NewLine);
        }
        catch { /* 日志失败不影响行为 */ }

        if (mode == "illegal-identity" && command.Contains("CIMSTATE:") && command.Contains("Get-CimInstance"))
        {
            Console.Out.Write("CIMSTATE:CREATED=not-a-date" + Environment.NewLine);
            return 0;
        }

        if (string.IsNullOrEmpty(real) || !File.Exists(real))
        {
            Console.Error.Write("test1337: real powershell not found (ANET_TEST1337_REAL_POWERSHELL)" + Environment.NewLine);
            return 127;
        }

        var psi = new ProcessStartInfo(real) { UseShellExecute = false, RedirectStandardOutput = false };
        foreach (string a in args) psi.ArgumentList.Add(a);
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
