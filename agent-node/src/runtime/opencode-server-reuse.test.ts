// #1293 negative controls: reuse must never cross identity, never target a
// non-loopback/stale/foreign candidate, never approve reuse without a live
// pid+startTicks observation, and must fall back rather than throw.
import { describe, expect, test } from "bun:test";
import { decideOpencodeServerReuse, isLoopbackServeUrl, type OpencodeServerReuseCandidate, type OpencodeServerReuseInput } from "./opencode-server-reuse.js";

const base: OpencodeServerReuseCandidate = {
  url: "http://127.0.0.1:4096",
  directory: "/srv/nodes",
  nodeId: "node-aaa",
  alias: "alpha",
  uid: 1000,
  pid: 4242,
  startTicks: 900,
  generation: "v2",
};

function input(overrides: Partial<OpencodeServerReuseInput> = {}): OpencodeServerReuseInput {
  return {
    nodeId: "node-aaa",
    alias: "alpha",
    workdirRoot: "/srv/nodes",
    uid: 1000,
    generation: "v2",
    candidates: [base],
    probeAlive: () => true,
    ...overrides,
  };
}

describe("opencode server reuse decision", () => {
  test("exact same identity reuses only with a live pid+startTicks probe", () => {
    const observed: Array<[number, number]> = [];
    const d = decideOpencodeServerReuse(input({ probeAlive: (pid, ticks) => { observed.push([pid, ticks]); return true; } }));
    expect(d.decision).toBe("reuse");
    expect(d.reason).toBe("same_identity_live");
    expect(d.candidate?.nodeId).toBe("node-aaa");
    expect(observed).toEqual([[4242, 900]]);
  });

  test("off mode preserves today's always-spawn behaviour", () => {
    expect(decideOpencodeServerReuse(input({ mode: "off" })).decision).toBe("fallback");
    expect(decideOpencodeServerReuse(input({ mode: "off" })).reason).toBe("reuse_off");
  });

  test("absent probe never approves reuse (no reuse on on-disk record alone)", () => {
    const d = decideOpencodeServerReuse(input({ probeAlive: undefined }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("probe_unavailable");
  });

  test("a throwing probe falls back and never escapes as a throw", () => {
    const d = decideOpencodeServerReuse(input({ probeAlive: () => { throw new Error("probe blew up"); } }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("probe_error");
  });

  test("missing startTicks is refused (PID reuse would be undetectable)", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, startTicks: null }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("missing_start_ticks");
  });

  test("cross-identity reuse is refused (credentials never shared)", () => {
    const d = decideOpencodeServerReuse(input({ nodeId: "node-bbb" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("identity_mismatch");
  });

  test("same nodeId but a different alias is refused", () => {
    const d = decideOpencodeServerReuse(input({ alias: "beta" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("alias_mismatch");
  });

  test("missing binding is refused (fail-closed)", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, nodeId: "" }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("missing_binding");
  });

  test("missing alias in the record is refused (fail-closed)", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, alias: "" }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("missing_binding");
  });

  test("non-loopback url is refused", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, url: "http://10.0.0.5:4096" }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("not_loopback");
  });

  test("dead server (pid not live) falls back, never reuses stale record", () => {
    const d = decideOpencodeServerReuse(input({ probeAlive: () => false }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("not_live");
  });

  test("foreign uid is refused", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, uid: 2000 }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("foreign_uid");
  });

  test("directory outside managed root is refused", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, directory: "/srv/other" }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("directory_mismatch");
  });

  test("generation mismatch is refused", () => {
    const d = decideOpencodeServerReuse(input({ generation: "v1" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("generation_mismatch");
  });

  test("empty candidates fall back", () => {
    expect(decideOpencodeServerReuse(input({ candidates: [] })).reason).toBe("no_candidate");
  });

  test("malformed record degrades to fallback, not throw", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [null, undefined, "x" as any, { url: 1 } as any] }));
    expect(d.decision).toBe("fallback");
  });

  test("first valid candidate wins over earlier refusals", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, nodeId: "node-zzz" }, base] }));
    expect(d.decision).toBe("reuse");
  });
});

describe("loopback url guard", () => {
  test.each([
    ["http://127.0.0.1:4096", true],
    ["http://localhost:4096", true],
    ["http://[::1]:4096", true],
    ["http://192.168.1.5:4096", false],
    ["https://127.0.0.1:4096", false],
    ["http://user:pass@127.0.0.1:4096", false],
    ["not-a-url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLoopbackServeUrl(url)).toBe(expected);
  });
});
