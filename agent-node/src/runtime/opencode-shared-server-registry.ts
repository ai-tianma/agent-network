import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export function readHostSharedOpenCodeServer(path: string): { opencodeSharedServerUrl: string; opencodeSharedServerPasswordFile: string } | undefined {
  if (!existsSync(path)) return undefined;
  const entry = JSON.parse(readFileSync(path, "utf8"));
  if (!entry || typeof entry.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.url)
    || typeof entry.passwordFile !== "string" || !isAbsolute(entry.passwordFile)) {
    throw new Error("shared_opencode_registry_invalid: expected loopback url and absolute passwordFile");
  }
  const passwordStat = statSync(entry.passwordFile);
  if (!passwordStat.isFile() || (passwordStat.mode & 0o077) !== 0) {
    throw new Error("shared_opencode_password_file_not_private");
  }
  return { opencodeSharedServerUrl: entry.url, opencodeSharedServerPasswordFile: entry.passwordFile };
}
