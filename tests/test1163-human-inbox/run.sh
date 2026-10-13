#!/usr/bin/env bash
set -euo pipefail
test -f /.dockerenv
echo "source_commit=$SOURCE_COMMIT"
COMMHUB_DB=/tmp/human-inbox.db bun test /repo/tests/test1163-human-inbox/human-inbox.test.ts
cp /repo/server/src/human-inbox.ts /tmp/human-inbox-original.ts
cp /repo/agent-node/src/cli.ts /tmp/human-inbox-cli.ts
for seam in auth depth request; do
  cp /tmp/human-inbox-original.ts /repo/server/src/human-inbox.ts
  cp /tmp/human-inbox-cli.ts /repo/agent-node/src/cli.ts
  SEAM="$seam" bun /repo/tests/test1163-human-inbox/mutation.ts
  if COMMHUB_DB=/tmp/human-inbox.db bun test /repo/tests/test1163-human-inbox/human-inbox.test.ts --test-name-pattern 'after 1000 blocked rows' > "/tmp/human-inbox-$seam.log" 2>&1; then
    echo "mutation unexpectedly passed: $seam" >&2; exit 1
  fi
  SEAM="$seam" bun -e 'const s=await Bun.file("/tmp/human-inbox-"+process.env.SEAM+".log").text();if(!s.includes("(fail)")||!s.includes("expect(received)"))throw Error("mutation did not witness assertion");console.log(process.env.SEAM+": ASSERTION RED");'
done
cp /tmp/human-inbox-original.ts /repo/server/src/human-inbox.ts
cp /tmp/human-inbox-cli.ts /repo/agent-node/src/cli.ts
