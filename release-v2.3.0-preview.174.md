# Agent Network CLI 2.3.0-preview.174 — paired login-persistence runtime

Pairs the CLI with `@sleep2agi/agent-node@2.5.0-preview.140` for V1 OpenCode
co-presence auth persistence. See the [runtime change](release-v2.5.0-preview.140.md)
and [runbook](docs/runbooks/opencode-tui-copresence.md).

The initialization/password implementation is unchanged. The formal package
must pass the usual main-source, install, getting-started and default-bootstrap
gates before public distribution. This candidate does not certify original-node
login/restart or history recovery, and does not change stable dist-tags.
