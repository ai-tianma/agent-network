import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSharedV2RegistryPlugin, V2_REGISTRY_RPC } from "./v2-readiness";

const binary = process.env.ANET_OPENCODE_V2_BIN;
const nativeTest = binary ? test : test.skip;

nativeTest("a real V2 shared server loads the project-scoped registry without a model turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "anet-v2-shared-native-"));
  const project = join(root, "project");
  const nodeDir = join(root, "node-private");
  const config = join(root, "config");
  const data = join(root, "data");
  const state = join(root, "state");
  for (const dir of [project, nodeDir, config, data, state]) mkdirSync(dir, { mode: 0o700 });
  const plugin = installSharedV2RegistryPlugin(nodeDir);
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: plugin }] }), { mode: 0o600 });
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("test port unavailable"));
      listener.close(() => resolve(address.port));
    });
  });
  const password = "native-test-only";
  const url = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "x-opencode-directory": project,
    "content-type": "application/json",
  };
  const server = spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      OPENCODE_DB: join(data, "opencode.db"),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error("isolated OpenCode Server exited before readiness");
      ready = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const configResponse = await fetch(`${url}/api/config`, { headers });
    expect(configResponse.status).toBe(200);
    const sources = await configResponse.json() as any[];
    expect(sources.some(entry => entry?.path === join(project, "opencode.json"))).toBe(true);
    const rpcResponse = await fetch(`${url}${V2_REGISTRY_RPC}`, {
      method: "POST", headers, body: '{"input":{}}',
    });
    expect(rpcResponse.status).toBe(200);
    const rpc = await rpcResponse.json() as any;
    expect(rpc.output).toEqual({ ready: false });
  } finally {
    server.kill("SIGTERM");
    if (server.exitCode === null) await Promise.race([
      new Promise(resolve => server.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
