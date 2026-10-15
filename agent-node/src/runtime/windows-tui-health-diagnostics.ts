// #1321 / parent #1285 — OPT-IN diagnostics for the Windows TUI health probe.
//
// Purpose: make the three exits of `probeWindowsTuiHealth` distinguishable on a
// real Windows runner WITHOUT changing any decision:
//   1. pre-check refusal (identity/url validation) — nothing was spawned;
//   2. the real PowerShell run rejected (timeout / spawn / non-zero exit);
//   3. the run resolved but printed an unrecognised value (`unknown`, empty, …).
//
// Rules from the card (#1321):
//   * DEFAULT OFF — `ANET_DIAG_WINDOWS_TUI_HEALTH` must be set to `1`;
//   * it WRAPS the real runner, never re-implements it (no second runner with
//     different semantics the test could slip past the product path);
//   * collection must never change the product outcome: the wrapped call returns
//     exactly what the real runner returned, and rethrows the SAME error object;
//   * no environment/token/header/login data; text is length-capped and redacted;
//   * the 10s timeout, the `running` assertion and the three-value stdout
//     protocol stay untouched (nothing here is wired into the decision).

/** Diagnostics are opt-in; anything other than `1` keeps today's behaviour. */
export function windowsTuiDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANET_DIAG_WINDOWS_TUI_HEALTH === "1";
}

/** Max characters of any free-form text that may reach the log. */
export const DIAG_TEXT_LIMIT = 240;

/** Length-cap and strip anything that looks like a credential or a URL query.
 * Deliberately conservative: over-redaction is cheaper than a leaked token. */
export function redactDiagText(value: unknown, limit = DIAG_TEXT_LIMIT): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text
    // A credential keyword: redact the whole value to end of line (over-redaction
    // is cheaper than leaking a token, and diagnostics are single-line by design).
    .replace(/(authorization|cookie|token|secret|password|apikey|api_key)\s*[:=][^\n]*/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s"']+/gi, "<url>")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit})` : text;
}

export type DiagRun = (script: string) => Promise<string>;

function describeError(error: unknown): string {
  const err = error as (Error & { code?: unknown; signal?: unknown; killed?: boolean; stderr?: unknown }) | undefined;
  const code = err?.code === undefined ? "n/a" : String(err.code);
  // node's execFile reports a timeout as killed=true with signal SIGTERM; the
  // pair is what makes "10s window" distinguishable from "spawn failed".
  const timeoutShape = err?.killed === true && String(err?.signal ?? "") === "SIGTERM";
  return [
    `code=${redactDiagText(code, 40)}`,
    `signal=${err?.signal === undefined ? "n/a" : String(err.signal)}`,
    `killed=${err?.killed === undefined ? "n/a" : String(err.killed)}`,
    `timeoutShape=${timeoutShape}`,
    `stderr=${redactDiagText(err?.stderr ?? err?.message ?? "")}`,
  ].join(" ");
}

/**
 * Wrap the REAL runner with timing + outcome attributes.
 *
 * Return/reject semantics are preserved exactly: a resolved string is passed
 * through untouched, and a rejection rethrows the original error object (so the
 * product's `catch` → `undefined` path is bit-for-bit the same). Nothing here
 * can turn a failure into a success or vice versa.
 */
export function diagnosingRunPowerShell(real: DiagRun, log: (line: string) => void = (l) => console.error(l)): DiagRun {
  return async (script) => {
    const started = Date.now();
    try {
      const stdout = await real(script);
      const reason = stdout.trim();
      try {
        log(`[diag-1321] probe run ok in ${Date.now() - started}ms stdout=${redactDiagText(reason, 60)}`);
      } catch { /* a logging failure must not change the outcome */ }
      return stdout;
    } catch (error) {
      // Never let diagnostics replace the product's failure: rethrow as-is.
      try {
        log(`[diag-1321] probe run rejected in ${Date.now() - started}ms ${describeError(error)}`);
      } catch { /* a logging failure must not change the outcome */ }
      throw error;
    }
  };
}

export interface FixtureBirthReading {
  ok: boolean;
  digitsOnly: boolean;
  durationMs: number;
  value: string;
}

/**
 * Time + validate a fixture-side birth query (the test's own PowerShell call).
 * The caller keeps its own value: this only reports, it never substitutes one.
 */
export function measureFixtureBirthQuery(
  query: () => string,
  log: (line: string) => void = (l) => console.error(l),
): FixtureBirthReading {
  const started = Date.now();
  let raw = "";
  let threw: unknown;
  try {
    raw = query();
  } catch (error) {
    threw = error;
  }
  const durationMs = Date.now() - started;
  const value = typeof raw === "string" ? raw.trim() : "";
  const reading: FixtureBirthReading = {
    ok: threw === undefined,
    digitsOnly: /^\d+$/.test(value),
    durationMs,
    value: redactDiagText(value, 40),
  };
  try {
    log(threw === undefined
      ? `[diag-1321] fixture birth query in ${durationMs}ms value=${reading.value} digitsOnly=${reading.digitsOnly}`
      : `[diag-1321] fixture birth query threw in ${durationMs}ms ${describeError(threw)}`);
  } catch { /* a logging failure must not change the outcome */ }
  return reading;
}

/** Report the pre-check gate the product would apply, read-only, without calling it.
 * Returned only for diagnosis: the probe remains the authority. */
export function describePreCheck(identity: { pid: number; creationDate: string; remote: string }): string {
  const problems: string[] = [];
  if (!Number.isInteger(identity.pid) || identity.pid <= 0) problems.push("pid");
  if (!/^\d+$/.test(identity.creationDate)) problems.push("creationDate-not-digits");
  try {
    const url = new URL(identity.remote);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") problems.push("remote-not-ws-loopback");
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("remote-port");
  } catch { problems.push("remote-unparseable"); }
  return problems.length === 0 ? "pre-check would pass" : `pre-check would refuse: ${problems.join(",")}`;
}
