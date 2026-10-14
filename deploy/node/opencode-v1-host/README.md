# V1 shared host input contract (#1208)

This is a versioned input template and read-only admission primitive, **not a
host launcher or an enabled shared runtime**. Do not copy it into a live node or
start a Server as an adoption step. Parent #1195 still needs supervisor/launcher,
scoped MCP proxy, borrowed lifecycle, exact readiness and turn integration.

The future supervisor prepares a canonical private host root owned by its UID,
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
secret is returned. Future launcher/consumer must revalidate immediately before
spawn/attach; this snapshot is neither a process lease nor protection against a
malicious peer using the same UID/password. A cohort label also does not prove
different provider credentials or safety policies are isolated.

Reconstruction evidence is in `tests/test1208-v1-host-admission/` and its Actions
workflow. It creates synthetic private files in non-root, network-disabled
Docker, checks refusal cases and reads a fixture native session through #1207.
No resident service, external proxy/tunnel or production port mapping is changed.
Production secrets remain original Owner's private sources; the template carries
only names/placeholders. Validate an exact main checkout and accepted package
before changing a software version; revert this source slice to roll it back.
Actual session databases, provider auth and Hub identities require encrypted
private backups/registration. Backup authority/location/retention and shared-aware
final checkpoint/rollback remain #1196; clone does not restore production data.
