# Windows co-presence health correction — CLI2.3.0-preview.178

Candidate paired runtime: Node2.5.0-preview.144, existing Hub0.9.0-preview.139. Not published until exact merged main formal gates pass; stable/latest unchanged. Full behavior/recovery limits: release-v2.5.0-preview.144.md and report-test1168-windows-health.txt.

## Install

After complete npm artifacts are verified, use a fresh private prefix, Node>=22.13 and Bun1.3.14 for Hub:

```bash
set -e
ANET_PAIR_DIR="$HOME/.anet-bin/windows-health178-144-139"
test ! -e "$ANET_PAIR_DIR"
install -d -m 700 "$ANET_PAIR_DIR"
umask 077
npm install --prefix "$ANET_PAIR_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/agent-network@2.3.0-preview.178 \
  @sleep2agi/agent-node@2.5.0-preview.144 \
  @sleep2agi/commhub-server@0.9.0-preview.139
```

## Upgrade

The original lifecycle owner adopts the pair through the normal `anet upgrade`/maintenance procedure. Preserve node/thread/cwd/model/login; verify actual paired entrypoints and a real Dashboard task. Publication does not restart or adopt a live node. Windows ongoing native TUI health remains unknown; app-server and expired/revoked login degradation remain enforced. Original-device and real-model acceptance are separate.

Existing deploy/hub and deploy/fleet runbooks cover launch/ports/proxy/secure environment sources. Roll back to immutable CLI177/Node143 with compatible V2 private receipts; the false-tmux issue returns. Git/frozen locks restore software only; private task/identity/login/receipt data require their existing authorized backup sources. Hub vault recovery remains NOT COVERED. No live deployment or credential copy occurs.
