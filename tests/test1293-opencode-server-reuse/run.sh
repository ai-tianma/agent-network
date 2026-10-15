#!/usr/bin/env bash
# #1293 / test1293 — OpenCode server reuse decision: fail-closed negative controls.
#
# Independent, isolated suite: no network (run with --network none), no
# credentials, no spawn, no lifecycle. It exercises only the pure decision
# module, which never reads a file or a credential and never signals a process.
set -euo pipefail
unset TMUX TMUX_PANE
export ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
mkdir -p "$ARTIFACT_DIR"
exec > >(tee "$ARTIFACT_DIR/report-test1293-runtime.txt") 2>&1
echo "test1293 opencode server reuse decision source=${SOURCE_COMMIT:-unset} date=$(date -Is)"
if [[ -n "${EXPECTED_SOURCE_COMMIT:-}" ]]; then test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"; fi

cd /opt/node_modules/@sleep2agi/agent-node

echo 'L0 unit: reuse is approved ONLY for an exact live (nodeId, alias) binding;'
echo '         cross-identity / alias mismatch / missing startTicks / absent or throwing'
echo '         probe / foreign uid / non-loopback / dead pid all fall back.'
bun test src/runtime/opencode-server-reuse.test.ts

echo 'guard: the decision module must not read or trust any file (no second registry)'
if grep -nE "readFileSync|lstatSync|openSync|realpathSync|readdirSync" src/runtime/opencode-server-reuse.ts; then
  echo 'FAIL: decision module reads/trusts files itself — candidates must come from the caller' >&2
  exit 1
fi

echo 'PASS: opencode server reuse decision suite'
