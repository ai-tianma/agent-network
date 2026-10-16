import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";

// #1337 —— 真实 CLI 停止「失败副作用」隔离见证（**纯测试夹具，无产品钩子**）。
//
// 复用**主流程已证明可行**的启动路径（现有 `windows-picker` 节点 + 既有 PTY 助手），
// 只在 `stop` 那一次调用注入夹具环境（私有 PATH + 具名模式），并用 **loopback 计数代理**
// 观测**真实的 Hub 请求**：把 Hub 指向切换成代理端口只发生在 `stop` 前后（用后即还原）。
//
// 断言的是**真实 CLI** 的 rc / 记录字节 / Hub 请求，而不是编排层布尔。
//
//   A 真实终止完成、包装器返回非零、精确身份均已退出 ⇒ rc0 / 记录删除 / Hub 请求被观测
//   B 包装器非零且**不终止**匹配身份                     ⇒ rc≠0 / 记录字节保留 / Hub 请求 0 / 身份仍活
//   C 仅**新身份协议查询**被返回非法（旧 ownership 预检走真实查询）
//                                                       ⇒ unverifiable / rc≠0 / 记录保留 / Hub 请求 0
export async function runStopEffectsScenarios({ cli, env, project, root, userHome, join, terminal }) {
  const shimDir = process.env.ANET_TEST1337_SHIM_DIR;
  const realHubPort = 19351;
  const proxyPort = 19352;
  const proxyHub = `http://127.0.0.1:${proxyPort}`;
  const node = "windows-picker";
  const record = join(project, ".anet", "nodes", node, "windows-copresence.json");
  const globalConfig = join(userHome, ".anet", "config.json");
  const nodeConfig = join(project, ".anet", "nodes", node, "config.json");
  const psLog = join(root, "test1337-ps.log");
  const tkLog = join(root, "test1337-tk.log");
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

  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
  const setHub = (p, hub) => { if (!existsSync(p)) return; const c = readJson(p); const prev = c.hub; c.hub = hub; writeFileSync(p, JSON.stringify(c)); c.__prev = prev; };
  const restoreHub = (p) => { if (!existsSync(p)) return; const c = readJson(p); if (c.__prev !== undefined) { c.hub = c.__prev; delete c.__prev; writeFileSync(p, JSON.stringify(c)); } };

  const probeTicks = (pid) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: "utf8" }).stdout.trim();

  /** 用主流程同款方式把节点跑到「有记录」的状态；返回身份与记录字节。 */
  async function startNode(label) {
    rmSync(record, { force: true });
    const out = await terminal(["node", "start", node, "--no-inherit-codex-home"], undefined, 120_000);
    if (!existsSync(record)) throw new Error(`test1337 ${label}: ${node} did not start\n${out}`);
    const bytes = readFileSync(record);
    return { bytes, identities: JSON.parse(bytes.toString()).processes };
  }

  /** 只在 stop 那一次注入夹具环境；Hub 指向临时切到代理用于计数。 */
  function shimmedStop(tkMode, psMode) {
    writeFileSync(psLog, "");
    writeFileSync(tkLog, "");
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
    // ⚠️ 已知障碍（如实保留，不静默降级）：把 CLI 的 hub 指到本 loopback 代理会让 `stop`
    //    **挂起超时（rc=null）** —— 该 CLI 的 hub 流量不是朴素 HTTP 反代可透明承载的形状
    //    （疑为 WS/SSE 升级或长连）。因此这里**只**切 global config 作计数尝试；
    //    若计数仍为 0 即打印明确失败信息，而不是把"没观测到"当成"没有请求"。
    setHub(globalConfig, proxyHub);
    hubRequests.length = 0;
    try {
      const res = spawnSync(process.env.ANET_TEST751_BUN, [cli, "node", "stop", node], { cwd: project, env: stopEnv, encoding: "utf8", timeout: 120_000 });
      return { rc: res.status, out: (res.stdout || "") + (res.stderr || ""), requests: [...hubRequests] };
    } finally {
      restoreHub(globalConfig);
      restoreHub(nodeConfig);
    }
  }

  const cleanup = (identities) => {
    for (const p of identities || []) {
      try { if (probeTicks(p.pid) === p.creationDate) spawnSync("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], { encoding: "utf8" }); } catch {}
    }
    rmSync(record, { force: true });
  };

  /** 观测运行期日志（不是编辑仓库源码证明见证红的变异）。 */
  const callLog = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

  console.log("PHASE test1337 A: taskkill 非零但已完成终止");
  {
    const s = await startNode("A");
    const r = shimmedStop("delegate-nonzero", "delegate");
    if (r.rc !== 0) throw new Error(`test1337 A: expected rc0, got ${r.rc}\n${r.out}`);
    if (existsSync(record)) throw new Error("test1337 A: record should be deleted after a settled stop");
    if (callLog(tkLog).trim() === "") throw new Error("test1337 A: taskkill wrapper never hit (no call log)");
    if (r.requests.length === 0) throw new Error("test1337 A: no Hub request observed through the counting proxy");
    console.log(`PASS test1337 A: rc0, record removed, hub requests=${r.requests.length}`);
  }

  console.log("PHASE test1337 B: taskkill 非零且未终止");
  {
    const s = await startNode("B");
    const r = shimmedStop("nonzero-noop", "delegate");
    if (r.rc === 0) throw new Error(`test1337 B: expected non-zero rc, got 0\n${r.out}`);
    if (!existsSync(record)) throw new Error("test1337 B: record must be retained");
    if (!readFileSync(record).equals(s.bytes)) throw new Error("test1337 B: record bytes changed");
    if (r.requests.length !== 0) throw new Error(`test1337 B: Hub requests must be 0, saw ${JSON.stringify(r.requests)}`);
    const alive = s.identities.filter((p) => { try { return probeTicks(p.pid) === p.creationDate; } catch { return false; } });
    if (alive.length === 0) throw new Error("test1337 B: expected the real managed identities to still be alive");
    cleanup(s.identities);
    console.log(`PASS test1337 B: rc=${r.rc}, record retained, hub requests=0, alive=${alive.length}`);
  }

  console.log("PHASE test1337 C: 仅新身份协议查询被挡");
  {
    const s = await startNode("C");
    const r = shimmedStop("delegate", "illegal-identity");
    if (r.rc === 0) throw new Error(`test1337 C: expected non-zero rc, got 0\n${r.out}`);
    if (!existsSync(record)) throw new Error("test1337 C: record must be retained");
    if (r.requests.length !== 0) throw new Error(`test1337 C: Hub requests must be 0, saw ${JSON.stringify(r.requests)}`);
    const log = callLog(psLog);
    if (log.trim() === "") throw new Error("test1337 C: powershell wrapper never hit (no call log)");
    if (!/illegal-identity\t.*GetProcessById/.test(log)) throw new Error("test1337 C: ownership pre-check did not go through the wrapper (must be a real query)");
    if (!/illegal-identity\t.*CIMSTATE:/.test(log)) throw new Error("test1337 C: new identity protocol query was not exercised");
    cleanup(s.identities);
    console.log(`PASS test1337 C: rc=${r.rc}, record retained, hub requests=0, illegal-identity only on the new protocol`);
  }

  await new Promise((r) => proxy.close(r));
  console.log("PASS test1337 real-CLI stop side-effect fixture (A/B/C)");
}
