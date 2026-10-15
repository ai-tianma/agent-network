// #1321 acceptance: prove each diagnostic exit preserves the product's return /
// reject semantics, that diagnostics are OFF unless opted in, and that no
// free-form text escapes un-redacted or unbounded.
import { describe, expect, test } from "bun:test";
import {
  DIAG_TEXT_LIMIT,
  describePreCheck,
  diagnosingRunPowerShell,
  measureFixtureBirthQuery,
  redactDiagText,
  windowsTuiDiagnosticsEnabled,
} from "./windows-tui-health-diagnostics";

const noop = () => {};

describe("#1321 diagnostics: opt-in and semantics-preserving", () => {
  test("default OFF — only an explicit 1 enables it", () => {
    expect(windowsTuiDiagnosticsEnabled({})).toBe(false);
    expect(windowsTuiDiagnosticsEnabled({ ANET_DIAG_WINDOWS_TUI_HEALTH: "0" })).toBe(false);
    expect(windowsTuiDiagnosticsEnabled({ ANET_DIAG_WINDOWS_TUI_HEALTH: "true" })).toBe(false);
    expect(windowsTuiDiagnosticsEnabled({ ANET_DIAG_WINDOWS_TUI_HEALTH: "1" })).toBe(true);
  });

  test("a resolved value passes through byte-for-byte", async () => {
    const wrapped = diagnosingRunPowerShell(async () => "running\n", noop);
    expect(await wrapped("script")).toBe("running\n");
  });

  test("a rejection rethrows the SAME error object (product catch path unchanged)", async () => {
    const original = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", killed: true, signal: "SIGTERM" });
    const wrapped = diagnosingRunPowerShell(async () => { throw original; }, noop);
    let caught: unknown;
    try { await wrapped("script"); } catch (error) { caught = error; }
    expect(caught).toBe(original); // identity, not a copy
    expect((caught as any).code).toBe("ENOENT");
  });

  test("the 10s-timeout shape is distinguishable from a spawn failure", async () => {
    const lines: string[] = [];
    const timeout = Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM" });
    await diagnosingRunPowerShell(async () => { throw timeout; }, (l) => lines.push(l))("s").catch(noop);
    expect(lines.join("\n")).toContain("timeoutShape=true");
    const spawn = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT", killed: false, signal: null });
    await diagnosingRunPowerShell(async () => { throw spawn; }, (l) => lines.push(l))("s").catch(noop);
    expect(lines.join("\n")).toContain("timeoutShape=false");
    expect(lines.join("\n")).toContain("code=ENOENT");
  });

  test("a throwing logger cannot change the outcome", async () => {
    const boom = new Error("logger exploded");
    const wrapped = diagnosingRunPowerShell(async () => { throw new Error("real"); }, () => { throw boom; });
    await expect(wrapped("s")).rejects.toThrow("real");
    const ok = diagnosingRunPowerShell(async () => "pane-dead", () => { throw boom; });
    expect(await ok("s")).toBe("pane-dead");
  });

  test("fixture reading reports duration/validity and still hands the value back", () => {
    const lines: string[] = [];
    const reading = measureFixtureBirthQuery(() => "12345678\n", (l) => lines.push(l));
    expect(reading.ok).toBe(true);
    expect(reading.digitsOnly).toBe(true);
    expect(reading.value).toBe("12345678");
    expect(typeof reading.durationMs).toBe("number");
    expect(lines.join("\n")).toContain("fixture birth query");

    const bad = measureFixtureBirthQuery(() => "not-a-number", noop);
    expect(bad.digitsOnly).toBe(false); // the H1 discriminator
    const threw = measureFixtureBirthQuery(() => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }); }, noop);
    expect(threw.ok).toBe(false);
  });

  test("pre-check reporting distinguishes the gate that would refuse", () => {
    expect(describePreCheck({ pid: 42, creationDate: "1234", remote: "ws://127.0.0.1:9000" })).toBe("pre-check would pass");
    expect(describePreCheck({ pid: 42, creationDate: "", remote: "ws://127.0.0.1:9000" })).toContain("creationDate-not-digits");
    expect(describePreCheck({ pid: 0, creationDate: "1234", remote: "ws://10.0.0.5:9000" })).toContain("pid");
    expect(describePreCheck({ pid: 42, creationDate: "1", remote: "nope" })).toContain("remote-unparseable");
  });

  test("text is length-capped and credentials/URLs are redacted", () => {
    expect(redactDiagText("a".repeat(1000)).length).toBeLessThanOrEqual(DIAG_TEXT_LIMIT + 12);
    expect(redactDiagText("Authorization: Bearer abcdef123456")).not.toContain("abcdef123456");
    expect(redactDiagText("token=deadbeefdeadbeefdeadbeefdeadbeef")).toContain("<redacted>");
    expect(redactDiagText("see https://example.test/path?q=1")).toContain("<url>");
    expect(redactDiagText("x".repeat(64))).toContain("<redacted>");
  });
});
