# CommHub 0.9.0-preview.138

GET `/api/requirements/stats` adds `tag_status`, a complete current snapshot of
visible unarchived tasks by tag and status. Multiple labels count one membership
per distinct tag; `tag: null` denotes no label. The snapshot is independent of
the completion time range. Optional `project_id` filters the snapshot and the
existing statistics; `none` selects tasks without a project. Omitting it keeps
the previous statistics scope and semantics. Lists advertise
`tag_status_snapshot` for consumers to detect the extension.

## Install

```bash
npm install --prefix <inactive-managed-prefix> @sleep2agi/commhub-server@0.9.0-preview.138
```

## Upgrade

After formal exact-main publication and complete public-byte verification,
follow `deploy/hub/README.md` for inactive installation, private consistent
backup, offline preflight, activation verification and software rollback. This
contract slice changes no production node, credentials, daemon or Hub profile;
the selected managed Hub remains137. Private data/original keys need their
existing private sources; whole credential recovery remains NOT_COVERED.

The chart and click-to-filter client UI are subsequent #1091 slices. This package
provides the server contract and does not claim the client feature complete.
Docker SQLite/PostgreSQL HTTP validation is recorded in
`report-test1091-tag-status.txt`; source CI, exact-main publication and real
client adoption are separate gates.
