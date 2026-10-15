// #1293 negative controls: reuse must never cross identity, never target a
// non-loopback/stale/foreign candidate, and must fall back rather than throw.
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
    ...overrides,
  };
}

describe("opencode server reuse decision", () => {
  test("exact same identity reuses", () => {
    const d = decideOpencodeServerReuse(input());
    expect(d.decision).toBe("reuse");
    expect(d.reason).toBe("same_identity_live");
    expect(d.candidate?.nodeId).toBe("node-aaa");
  });

  test("off mode preserves today's always-spawn behaviour", () => {
    expect(decideOpencodeServerReuse(input({ mode: "off" })).decision).toBe("fallback");
    expect(decideOpencodeServerReuse(input({ mode: "off" })).reason).toBe("reuse_off");
  });

  test("cross-identity reuse is refused (credentials never shared)", () => {
    const d = decideOpencodeServerReuse(input({ nodeId: "node-bbb" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("identity_mismatch");
  });

  test("missing binding is refused (fail-closed)", () => {
    const d = decideOpencodeServerReuse(input({ candidates: [{ ...base, nodeId: "" }] }));
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
