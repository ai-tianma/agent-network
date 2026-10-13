# Agent Node 2.5.0-preview.140 — V1 co-presence login persistence

Paired CLI: `@sleep2agi/agent-network@2.3.0-preview.174`.

V1 OpenCode co-presence now stages node-local API/OAuth/wellknown auth data in
the fresh launch directory and atomically saves changed login, refresh and
logout data after owned processes exit, before cleaning that directory.
Version probes and headless ACP keep their existing credential boundaries.
Concurrent node-auth edits and unsafe credential paths are refused without
overwriting them. No credential values are included in persistence errors.

This covers normal stop/restart, not SIGKILL/crash recovery or deleted auth.
Session-history recovery and actual original-node login/restart feedback remain
separate acceptance gates. Use the [co-presence runbook](docs/runbooks/opencode-tui-copresence.md)
for private state backup, software rollback and pending live verification.

Candidate only until normal exact-main formal gates and public full-byte
verification pass. No stable tag change is requested.
