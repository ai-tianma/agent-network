# V1 host input and independent Owner launcher (#1208/#1210)

The versioned template/read-only admission primitive now has a separate Linux
Host Owner foreground entry and supervisor template. **The node shared runtime
is not enabled.** Parent #1195 still needs scoped MCP proxy, borrowed lifecycle,
exact node readiness/turn integration and original Owner adoption. This source
change does not deploy the template or start any live production Host.

Create an explicitly selected, canonical private root with mode 0700 as its Host
Owner. From an exact main checkout, the versioned foreground entry is:

```sh
bun deploy/node/opencode-v1-host/start.ts --root /PRIVATE/CANONICAL/HOST_ROOT --binary /ATTESTED/OPENCODE/PACKAGE/bin/opencode --version 1.18.34 --host-id OWNER_SELECTED_HOST --cohort OWNER_SELECTED_COHORT --port 19208
```

The accepted previous version is 1.18.1; Windows/macOS Host launch is not enabled
by this first Linux process-ownership gate. The binary is attested in an empty
temporary probe root before the private runtime environment is supplied. Every
incarnation gets a new random instance ID/password; authenticated exact-version
health succeeds before exclusive registry publication. Port conflict refuses,
never chooses another Server. Foreground ready output carries only public
identity/version/origin/PID/registry path. It never prints the password.

`supervisor.service.template` specifies the same entry, chosen UID, private umask,
no automatic restart and a foreground-only service lifetime. Do not install it
for an existing cohort without the original Owner's named idle window/backup.
The independent Host owns its detached process group; borrowing nodes must never
call this start/stop API. SIGTERM/SIGINT stops only that attested group, removes
only unchanged owned controls and retains persistent roots. Unexpected child
exit withdraws its controls. Edited controls/unknown ownership/residual locks
refuse takeover and require Owner recovery; no PID-based clearing or replay.

Clean restart of the same Host/cohort/version retains `host-settings.json` and
all roots, rotates instance/password, and refuses old node bindings. Explicit
Owner verification/rebinding is a separate step; history is not auto migrated.

The supervisor prepares a canonical private host root owned by its UID,
mode 0700, and the seven fixed child directories in `registry.template.json`,
each canonical, same UID, mode 0700. `registry.json` and `server.password` must be
regular single-link files, same UID, mode 0600. Symlinks, public paths, unknown
schemas/generations and package/version mismatch are refused without rewriting.
The password is 32 random bytes represented as 64 lowercase hex characters,
optionally followed by one newline. No password value is stored in the registry.

Select `hostId`/`cohortId` independently in operator configuration. Generate a new
128-bit `instanceId` for each actual Server incarnation; keep persistent data
roots, but reject stale bindings unless an explicit, verified recovery switches
them. A registry value/PID/HTTP health alone does not prove a running instance.
The loader requires an independently supplied current expectation plus the
existing credential-free exact package/binary attestation, rechecked before any
secret is returned. The launcher rechecks before spawn; future borrowers must
revalidate before attach. This snapshot is neither a process lease nor protection against a
malicious peer using the same UID/password. A cohort label also does not prove
different provider credentials or safety policies are isolated.

Reconstruction evidence is in `tests/test1208-v1-host-admission/` and
`tests/test1210-v1-host-launcher/` with their Actions workflows. They create
synthetic private files in non-root, network-disabled Docker and exercise native
startup/refusal, two nonempty directory histories/restart, stale binding and an
independent Host unaffected by exact owned shutdown. This is not a shared-node
borrower stop test, policy/credential isolation or original native adoption.
No resident service, external proxy/tunnel or production port mapping is changed.
Production secrets remain original Owner's private sources; the template carries
only names/placeholders. Stable private Host settings prevent silent version or
cohort reuse. For upgrade/rollback, the Owner drains the actual cohort, retains
the exact old installation/config and encrypted offline data backup, and verifies
scratch restoration with #1196 before switching/rebinding. No hot DB copying,
automatic version rewrite or lossless rollback is claimed. Revert the software
slice on main for source rollback; later turns still require a final checkpoint.
Actual session databases, provider auth and Hub identities require encrypted
private backups/registration. Backup authority/location/retention and shared-aware
final checkpoint/rollback remain #1196; clone does not restore production data.
# Directory-bound MCP primitive (#1212)

Host Owner may explicitly select `--scoped-commhub-mcp` on a **new, private,
equivalent-policy trust cohort**. The default still denies all tools. This option
removes V1's catch-all deny only after keeping every pinned built-in explicitly
denied, and allows `commhub_*` only. It is recorded in persistent Host settings;
changing it on retained data refuses instead of silently adopting another policy.
The node's Hub token never enters Host environment/configuration. Same UID and
Host password remain cooperative trust, not tenant or provider-secret isolation.

`agent-node/src/runtime/opencode-copresence/v1-scoped-mcp.ts` supplies a separately
reviewable API, not a Node opt-in switch. `openV1ScopedCommhubMcp` needs independent
expected network/node/Host-instance/canonical-directory/exact-session identity,
fresh original binding/admitted Host readers, original node alias/token and an
existing separate private state root. It checks the full binding, exact native
session/directory and unchanged Host authority before forwarding each MCP request.
An original node token authenticates upstream caller identity; prompts cannot
select credentials, network or outbound sender. MCP itself does not provide a
trusted session/turn identity. The unique directory capability prevents accidental
crosswiring, but this API does not prove human/network turn ownership.

The proxy uses an ephemeral `127.0.0.1` port and random bearer capability. Only
that short-lived local capability goes into private V1 flat `mcp.commhub` config;
upstream Hub credentials stay in bridge memory and do not appear in errors.
It retains provider/model/other MCP entries and creates scoped instructions in
the private node state root. Plain JSON/private single-link 0600 project config
is required; existing CommHub, V2 config, JSONC or wildcard-denied project policy
refuses rather than overwrites or widens it. An exclusive `.anet-v1-mcp.lock`
prevents a second bridge in that directory. It does not support two node identities
in one canonical directory.

Writing project config is **not proof of native activation**. The isolated test
characterizes cached `/config` after an instance already exists, then exercises
directory-scoped V1 `POST /mcp` and verifies live native tools using a synthetic
model. No global/directory dispose, Host restart or live Node adoption is performed
by this API. Borrowed runtime integration must explicitly reconcile native state
and revoke/disconnect only its own MCP before publishing readiness or releasing
the directory; that consumer and ready/turn contract remain #1195.

Close revokes the capability and its HTTP connections, and restores exact original
config bytes only while its own installed inode/bytes and recovery files are
unchanged. Edited config/control files are retained, with a reported cleanup gap;
the dead capability is never resurrected. Private `v1-mcp-<lease>.original` and
instruction files plus the project lock remain for the named Owner to inspect.
Crash recovery does not adopt a stale lock automatically: Owner must verify no
bridge owns it, preserve edits, recover original private data, and explicitly
prepare a new lease. Backup private project settings/data under the existing
Owner-managed encrypted-data procedure before actual adoption; Git does not
contain their secrets. Upgrade/rollback uses exact merged-main software and
retained private backups; changed Host policy requires a separately chosen root.

Both pinned V1 packages must pass `tests/test1212-v1-scoped-mcp/Dockerfile` via
`v1-scoped-mcp-core.yml` before ordinary main merge. It pins source/Bun/package
integrity, uses non-root network-disabled Docker and synthetic credentials/model.
This proves the MCP/config primitive only; full borrowed Node lifecycle,
ready/turn/abort, migration/final-checkpoint rollback and original Owner canary
remain separate gates. No production files or running services are changed here.

