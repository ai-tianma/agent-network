# test1293 — OpenCode server reuse decision

Independent Docker suite for the #1293 decision slice
(`agent-node/src/runtime/opencode-server-reuse.ts`).

## What it proves

The decision to **reuse an already-running host OpenCode server instead of
spawning a new one** is fail-closed. Reuse is approved only for an **exact live
(nodeId, alias) binding**; every other path is a fallback:

- cross-identity (`nodeId`) and alias mismatch
- missing node binding / missing alias
- `startTicks` missing (PID reuse undetectable)
- probe absent (`probe_unavailable`) or throwing (`probe_error`) — never throws
- dead pid (`not_live`)
- foreign uid, non-loopback url, directory outside the managed root,
  generation mismatch
- malformed records degrade to fallback

It also asserts the module has **no file-reading surface** — candidates are
supplied by the caller (the authoritative host shared-server registry reader),
so this module introduces no second registry and no second file-trust surface.

## How to run

```sh
sg docker -c 'docker build -f tests/test1293-opencode-server-reuse/Dockerfile \
  -t anet-test1293 .'
sg docker -c 'docker run --rm --network none -v "$PWD/docs/tests:/artifacts" anet-test1293'
```

Checked-in report: `docs/tests/report-test1293-opencode-server-reuse.txt`.

## Limits

This suite covers the **decision only**. It does not prove the wired
create/start path, native V2 startup, server sharing, TUI, or lifecycle cleanup.
The production wiring/qualification lives with the host shared-registry path
(PR #2776) and is tracked by #1302.
