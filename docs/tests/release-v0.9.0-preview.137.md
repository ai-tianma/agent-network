# CommHub 0.9.0-preview.137

Daemon discovery through MCP and REST now verifies credentials and heartbeats
against immutable node identity. A same-name sibling can no longer lend its
credentials or heartbeat to a stopped daemon. Bound tokens survive node renames;
verified legacy unbound tokens and unique legacy heartbeats remain supported.
List reads batch identity checks into three database reads, with one result per
daemon even during token rotation. Existing scope and telemetry masking remain.

## Install

```bash
npm install --prefix <inactive-managed-prefix> @sleep2agi/commhub-server@0.9.0-preview.137
```

## Upgrade

After formal main-only publication and full artifact/SRI verification, install
the exact version into an inactive prefix. Follow `deploy/hub/README.md` for the
private consistent database backup, offline schema preflight, selected Hub
activation and health check. Keep the previous verified prefix for rollback.
This release changes no schema, service ports, node launch authority or secrets.
The existing managed deployment remains on Hub136 until a separate profile,
lock and actual activation are verified. Private data and key recovery still
require their original private sources; full credential recovery is NOT_COVERED.

Source Docker results are tracked in `report-test1109-supervisor-identity.txt`.
Source verification, main publication and real-node display acceptance are
separate gates. This candidate does not close the original Node139 activity
canary or OpenCode original-account restart acceptance.
