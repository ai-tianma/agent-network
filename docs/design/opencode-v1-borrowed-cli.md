# Explicit V1 borrowed CLI selection (#1224)

This source slice connects the existing `agent-node` CLI co-presence path to
#1216/#1219 borrowed V1 API. Default nodes keep owned startup. This is a
cooperative same-UID/provider-policy cohort, not a hostile tenant boundary.
Host creation/session provisioning, interactive TUI attach, migration and
original-device adoption remain separate Owner-authorised gates.

Use a private canonical `<project>/.anet/nodes/<node-id>/config.json` with its
existing private runtime binding and original node login. Set runtime
`opencode-cli`, opencodeGeneration `v1`, opencodeMode `copresence`, and explicit
node_id/network_id/alias/model/session. Add `opencodeBorrowedV1` with exactly:

```json
{
  "schema": 1,
  "hostRoot": "/private/selected-host",
  "expectedHost": {
    "hostId": "OWNER_SELECTED_HOST_ID",
    "instanceId": "OWNER_SELECTED_32_HEX_INCARNATION",
    "version": "1.18.34",
    "cohortId": "OWNER_SELECTED_COHORT"
  },
  "selectedCohortId": "OWNER_SELECTED_COHORT",
  "binding": {
    "networkId": "ORIGINAL_NETWORK_ID",
    "nodeId": "ORIGINAL_NODE_ID",
    "serverIdentity": "OWNER_SELECTED_HOST_ID:OWNER_SELECTED_32_HEX_INCARNATION",
    "directory": "/canonical/project",
    "sessionId": "ses_ORIGINAL_EXACT_ID"
  }
}
```

Placeholders must be replaced with the Owner's independently selected exact
expectation and existing binding, never inferred/adopted from registry/health
or latest session. No URL/password/token/provider secret belongs in this
selection. Original Hub credential stays in its existing private node login;
the scoped proxy receives the CLI's credential, not shared Host environment.
The selected native binary must be outside project/node/Host state and match
the pinned package/version attestation; the Host registry remains independently
validated. Built-in tools stay denied and scoped CommHub MCP requires the
explicit Host policy/cohort from the earlier contract.

Start the existing built CLI with its private config (no new public environment
switch): `node agent-node/dist/cli.js --config /private/node/config.json`.
Normal launcher config propagation remains the existing route; its interactive
TUI/start-completion UI is not qualified by this standalone CLI fixture.
Node cwd, persisted session, model, network and node identity must match the
selection. Unknown fields, V2, unsafe tools, headless or `--new-session` refuse.
The Hub credential must match the original private node config; global fallback
cannot satisfy borrowed admission. A credential change requires explicit restart.
Each request rereads the private node config, comparing frozen selection and
identity. Borrowed session callback does not rewrite config/session or import
owned checkpoint data, and no owned MCP credentials/provider env are passed
to the borrowed backend.

`opencode-borrowed-v1-selection.json` is a private non-secret intent record in
node state. It persists through clean close and config self-heal. An absent
borrowed selection with that record refuses owned fallback. Changing Host
incarnation or switching back to owned requires explicit migration/rollback;
do not delete the record as an automatic repair. An unavailable borrowed
runtime retains its original handle/binding/recovery and refuses automatic
reopen. SIGTERM closes only the node's scoped MCP/config; no shared Host or
human TUI is stopped. Unknown recovery remains retained.

## Rebuild and rollback

- Software startup is the existing `agent-node/src/cli.ts` built by its locked
  package script; independent Host startup is `deploy/node/opencode-v1-host`.
  The new suite has its own Dockerfile/run.sh and pinned native SRI inputs.
- Host/proxy ports are loopback, recorded in the private Host registry; this
  slice needs no reverse proxy/tunnel and changes no production mapping.
- Real Hub/Host/provider credentials come from original Owner-controlled login
  and encrypted backup; no credentials are committed, read or changed here.
- Pin a main-merged source and native package/version/SRI, then verify the actual
  selected session and native task reply; source/CI is not proof of live adoption.
- Roll back software by selecting the previous main source. Restore selected
  node/Host config and intent record from the same approved backup/window;
  no automatic mode downgrade, unknown clearing or replay is provided.
- Git restores software/schema/templates. Existing session history, node login,
  config/selection intent and unknown leases require original encrypted data
  backup and #1196 migration/rollback qualification, not clone alone.
