#!/bin/sh
set -eu
bun test server/src/host-execution-receipt.test.ts
bun test server/src/host-execution-http.test.ts
# Existing server authority, status/fork and read-scope contracts, fresh DB each.
COMMHUB_DB=/tmp/1493-start.db bun test server/src/start-node.test.ts
COMMHUB_DB=/tmp/1493-stop.db bun test server/src/stop-delete-node.test.ts
COMMHUB_DB=/tmp/1493-read.db bun test server/src/node-lifecycle-read-http.test.ts
# Existing runtime start/create/stop behavior; old Hub path must remain intact.
bun test agent-node/src/runtime/start-daemon.test.ts
bun test agent-node/src/runtime/create-node-daemon.test.ts
# Fault mutation controls run last, in disposable copies only.
node tests/test1493-host-execution/mutants.mjs
