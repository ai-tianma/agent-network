import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SharedV2McpHandle {
  url: string;
  close(): Promise<void>;
}

/** The bridge owns the Hub token; a shared OpenCode process only sees this
 *  workspace's short-lived, loopback-only MCP endpoint. */
export async function openSharedV2CommhubMcp(
  cwd: string,
  workDir: string,
  hubUrl: string,
  hubToken: string,
  instructionPath: string,
): Promise<SharedV2McpHandle> {
  const upstream = new URL(hubUrl);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || !hubToken) {
    throw new Error("Shared OpenCode MCP requires a credential-free Hub URL and node token");
  }
  const nonce = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${nonce}`);
  const server: Server = createServer((incoming, outgoing) => {
    const incomingUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (incomingUrl.pathname !== "/mcp") { outgoing.writeHead(404).end(); return; }
    const supplied = Buffer.from(incoming.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      outgoing.writeHead(401).end();
      return;
    }
    const headers = { ...incoming.headers, host: upstream.host, authorization: `Bearer ${hubToken}` };
    delete headers.connection;
    const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const targetUrl = new URL(upstream);
    targetUrl.search = incomingUrl.search;
    const target = transport(targetUrl, { method: incoming.method, headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    target.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(target);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Shared MCP proxy did not bind a TCP port");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const configPath = join(cwd, "opencode.json");
  const backupPath = join(workDir, "opencode-shared-project-config.backup");
  const saved = existsSync(backupPath)
    ? readFileSync(backupPath)
    : existsSync(configPath) ? readFileSync(configPath) : undefined;
  const original = saved?.length ? saved : undefined;
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600;
  let installed: Buffer | undefined;
  try {
    const config = original ? JSON.parse(original.toString("utf8")) : {};
    if (config.mcp?.servers?.commhub) throw new Error("Workspace already defines a CommHub MCP server");
    if (!existsSync(backupPath)) writeFileSync(backupPath, original ?? Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    config.mcp = {
      ...(config.mcp ?? {}),
      servers: {
        ...(config.mcp?.servers ?? {}),
        commhub: { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${nonce}` } },
      },
    };
    config.instructions = [...(config.instructions ?? []), instructionPath];
    installed = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
    const temporary = `${configPath}.anet-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(temporary, installed, { flag: "wx", mode: 0o600 });
    renameSync(temporary, configPath);
    chmodSync(configPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (!installed || !existsSync(configPath) || !readFileSync(configPath).equals(installed)) return;
      if (original) {
        const temporary = `${configPath}.anet-restore-${process.pid}`;
        writeFileSync(temporary, original, { flag: "wx", mode: 0o600 });
        renameSync(temporary, configPath);
        chmodSync(configPath, mode);
      } else {
        rmSync(configPath);
      }
      rmSync(backupPath, { force: true });
    },
  };
}
