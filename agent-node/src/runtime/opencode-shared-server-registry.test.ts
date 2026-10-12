import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostSharedOpenCodeServer } from "./opencode-shared-server-registry.js";

describe("host shared OpenCode Server registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "anet-shared-registry-"));
  const registry = join(dir, "registry.json");
  const passwordFile = join(dir, "password");
  test("absent registry retains node-owned mode", () => {
    expect(readHostSharedOpenCodeServer(registry)).toBeUndefined();
  });
  test("private registered Server becomes node config fields", () => {
    writeFileSync(passwordFile, "test-only-password", { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile }));
    expect(readHostSharedOpenCodeServer(registry)).toEqual({
      opencodeSharedServerUrl: "http://127.0.0.1:4097",
      opencodeSharedServerPasswordFile: passwordFile,
    });
  });
  test("does not accept a public password file", () => {
    chmodSync(passwordFile, 0o644);
    expect(() => readHostSharedOpenCodeServer(registry)).toThrow("shared_opencode_password_file_not_private");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
