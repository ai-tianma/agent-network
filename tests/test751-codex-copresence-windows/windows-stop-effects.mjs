import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";

// #1337 —— 真实 CLI 停止「失败副作用」隔离见证（**纯测试夹具，无产品钩子**）。
//
// 由 `compile-shims.ps1` 编译出真实 `.exe` 包装器（`powershell.exe` / `taskkill.exe`），
// 本模块只在**该次 CLI 子进程**的私有 `PATH` 前置它们（不改全局 PATH），并用 **loopback
// 计数代理**观测**真实的 Hub 离线请求**。断言的是真实 CLI 的 rc / 记录字节 / Hub 请求，
// 不是编排层布尔。
//
// 场景：
//   A 真实终止完成、包装器返回非零、精确身份均已退出 ⇒ rc0 / 记录删除 / Hub 请求被观测
//   B 包装器非零且**不终止**匹配身份                     ⇒ rc≠0 / 记录字节保留 / Hub 请求 0 / 身份仍活
//   C 仅**新身份协议查询**被返回非法（旧 ownership 预检走真实查询）
//                                                       ⇒ unverifiable / rc≠0 / 记录保留 / Hub 请求 0
export async function runStopEffectsScenarios({ cli, env, project, root, join }) {
  const shimDir = process.env.ANET_TEST1337_SHIM_DIR;
  const realHubPort = 19351;
  const proxyPort = 19352;
  const hubRequests = [];
  const proxy = createServer((req, res) => {
    hubRequests.push(`${req.method} ${req.url}`);
    const up = httpRequest({ host: "127.0.0.1", port: realHubPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));

  const shimNode = "windows-picker-shim";
  const shimRecord = join(project, ".anet", "nodes", shimNode, "windows-copresence.json");
  const psLog = join(root, "test1337-ps.log");
  const tkLog = join(root, "test1337-tk.log");
  const bun = process.env.ANET_TEST751_BUN;

  const probeTicks = (pid) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: "utf8" }).stdout.trim();

  /** 用给定夹具模式跑一次**真实** `node stop`，返回 rc（不抛）。 */
  function stopWithShim(tkMode, psMode) {
    writeFileSync(psLog, "");
    writeFileSync(tkLog, "");
    rmSync(shimRecord, { force: true });
    const started = spawnSync(bun, [cli, "node", "start", shimNode, "--no-inherit-codex-home"], { cwd: project, env, encoding: "utf8", timeout: 90_000 });
    if (started.status !== 0 || !existsSync(shimRecord)) throw new Error(`test1337 ${tkMode}/${psMode}: shim node did not start (rc=${started.status})\n${started.stdout}${started.stderr}`);
    const before = readFileSync(shimRecord);
    const identities = JSON.parse(before.toString()).processes;
    hubRequests.length = 0;
    const stopEnv = {
      ...env,
      PATH: `${shimDir};${env.PATH}`,
      ANET_TEST1337_PS_MODE: psMode,
      ANET_TEST1337_TK_MODE: tkMode,
      ANET_TEST1337_PS_LOG: psLog,
      ANET_TEST1337_TK_LOG: tkLog,
      ANET_TEST1337_REAL_POWERSHELL: process.env.ANET_TEST1337_REAL_POWERSHELL,
      ANET_TEST1337_REAL_TASKKILL: process.env.ANET_TEST1337_REAL_TASKKILL,
    };
    const res = spawnSync(bun, [cli, "node", "stop", shimNode], { cwd: project, env: stopEnv, encoding: "utf8", timeout: 90_000 });
    return { rc: res.status, out: (res.stdout || "") + (res.stderr || ""), before, identities, requests: [...hubRequests] };
  }

  /** 只清理本夹具创建且**出生身份匹配**的进程；随后删除记录。 */
  const cleanupShimNode = (identities) => {
    for (const p of identities || []) {
      try { if (probeTicks(p.pid) === p.creationDate) spawnSync("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], { encoding: "utf8" }); } catch {}
    }
    rmSync(shimRecord, { force: true });
  };

  /** 读一次调用日志（**观测运行期日志**，不是编辑仓库源码证明见证红的变异）。 */
  const callLog = (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

  console.log("PHASE test1337 create shim node via counting proxy");
  const created = spawnSync(bun, [cli, "node", "create", shimNode, "--hub", `http://127.0.0.1:${proxyPort}`], { cwd: project, env, encoding: "utf8", timeout: 90_000 });
  if (created.status !== 0) throw new Error(`test1337: shim node create failed (rc=${created.status})\n${created.stdout}${created.stderr}`);

  // A —— 真实终止完成但包装器非零 ⇒ rc0 / 记录删除 / Hub 离线请求被观测
  {
    const r = stopWithShim("delegate-nonzero", "delegate");
    if (r.rc !== 0) throw new Error(`test1337 A: expected rc0, got ${r.rc}\n${r.out}`);
    if (existsSync(shimRecord)) throw new Error("test1337 A: record should be deleted after a settled stop");
    if (callLog(tkLog).trim() === "") throw new Error("test1337 A: taskkill wrapper never hit (no call log)");
    if (r.requests.length === 0) throw new Error("test1337 A: no Hub request observed through the counting proxy");
    console.log(`PASS test1337 A: rc0, record removed, hub requests=${r.requests.length}`);
  }

  // B —— 包装器非零且**不终止**匹配身份 ⇒ rc≠0 / 记录字节保留 / Hub 请求 0 / 真实身份仍活
  {
    const r = stopWithShim("nonzero-noop", "delegate");
    if (r.rc === 0) throw new Error(`test1337 B: expected non-zero rc, got 0\n${r.out}`);
    if (!existsSync(shimRecord)) throw new Error("test1337 B: record must be retained");
    if (!readFileSync(shimRecord).equals(r.before)) throw new Error("test1337 B: record bytes changed");
    if (r.requests.length !== 0) throw new Error(`test1337 B: Hub requests must be 0, saw ${JSON.stringify(r.requests)}`);
    const alive = r.identities.filter((p) => { try { return probeTicks(p.pid) === p.creationDate; } catch { return false; } });
    if (alive.length === 0) throw new Error("test1337 B: expected the real managed identities to still be alive");
    cleanupShimNode(r.identities);
    console.log(`PASS test1337 B: rc=${r.rc}, record retained, hub requests=0, alive=${alive.length}`);
  }

  // C —— 仅**新身份协议查询**被挡；旧 ownership 预检走真实查询 ⇒ unverifiable / rc≠0 / 记录保留 / Hub 0
  {
    const r = stopWithShim("delegate", "illegal-identity");
    if (r.rc === 0) throw new Error(`test1337 C: expected non-zero rc, got 0\n${r.out}`);
    if (!existsSync(shimRecord)) throw new Error("test1337 C: record must be retained");
    if (r.requests.length !== 0) throw new Error(`test1337 C: Hub requests must be 0, saw ${JSON.stringify(r.requests)}`);
    const log = callLog(psLog);
    if (log.trim() === "") throw new Error("test1337 C: powershell wrapper never hit (no call log)");
    if (!/illegal-identity\t.*GetProcessById/.test(log)) throw new Error("test1337 C: ownership pre-check did not go through the wrapper (must be a real query)");
    if (!/illegal-identity\t.*CIMSTATE:/.test(log)) throw new Error("test1337 C: new identity protocol query was not exercised");
    cleanupShimNode(r.identities);
    console.log(`PASS test1337 C: rc=${r.rc}, record retained, hub requests=0, illegal-identity only on the new protocol`);
  }

  await new Promise((r) => proxy.close(r));
  console.log("PASS test1337 real-CLI stop side-effect fixture (A/B/C)");
}
