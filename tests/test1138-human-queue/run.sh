#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
bun test src/inbox-dispatch.test.ts src/runtime/codex-app-server/interactive-queue.test.ts \
  src/runtime/codex-app-server/queue-timeout-env.test.ts src/runtime/codex-app-server/runtime.test.ts \
  src/runtime/codex-app-server/queued-row-hub-check.test.ts src/runtime/codex-app-server/queued-row-skip.test.ts
# The true production CLI entry must expose the audience only when its
# authenticated inbox flag reaches it. Keep this mutation inside Docker.
bun -e 'const p="src/cli.ts"; const s=await Bun.file(p).text(); const a="interactiveDashboardTask: steerIfExternalTurn,"; if(s.split(a).length!==2) throw Error("unique production marker missing"); await Bun.write(p,s.replace(a,"interactiveDashboardTask: false,"));'
if bun test src/runtime/codex-app-server/interactive-queue.test.ts --test-name-pattern 'production CLI passes' > /tmp/queue1138-witness.log 2>&1; then
  echo 'production queue wiring witness unexpectedly passed' >&2; exit 1
fi
bun -e 'const s=await Bun.file("/tmp/queue1138-witness.log").text(); if(!s.includes("(fail)")||!s.includes("expect(received)")) throw Error("witness did not reach audience assertion"); console.log("production queue audience wiring: ASSERTION RED");'
