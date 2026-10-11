#!/usr/bin/env python3
"""Reuse a main release.yml tarball; never build or republish npm here."""
import argparse
import hashlib
import json
import re
import tarfile
from pathlib import Path

GATES = (
    "build tarball",
    "gate 1 — install-path smoke (real TTY)",
    "gate 2 — PINNED_* version pin audit",
    "gate 3 — release notes shape (Install + Upgrade)",
    "gate 4 — 上手指南里的版本断言",
)


def validate_run(run, jobs, commit, run_id):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("full40 main source required")
    if (run.get("id") != int(run_id) or run.get("head_sha") != commit
            or run.get("head_branch") != "main"
            or run.get("event") != "workflow_dispatch"
            or run.get("path") != ".github/workflows/release.yml"):
        raise ValueError("not the requested official main release run")
    for name in GATES:
        matches = [j for j in jobs["jobs"] if j.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != "success":
            raise ValueError("required package gate not successful: " + name)


def validate_tarball(path, version, expected_sha):
    if not re.fullmatch(r"2\.3\.0-preview\.\d+", version):
        raise ValueError("explicit CLI preview version required")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise ValueError("explicit inner tarball SHA256 required")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_sha:
        raise ValueError("inner tarball byte mismatch")
    with tarfile.open(path, "r:gz") as archive:
        manifest = json.load(archive.extractfile("package/package.json"))
    if manifest.get("name") != "@sleep2agi/agent-network" or manifest.get("version") != version:
        raise ValueError("wrong CLI package identity/version")
    return digest


def main():
    parser = argparse.ArgumentParser()
    for key in ("commit", "run-id", "version", "sha256", "directory"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    validate_run(json.loads(Path("release-run.json").read_text()),
                 json.loads(Path("release-jobs.json").read_text()), args.commit, args.run_id)
    packages = list(Path(args.directory).glob("*.tgz"))
    if len(packages) != 1:
        raise ValueError("exactly one gated tarball required")
    validate_tarball(packages[0], args.version, args.sha256)
    if json.loads(Path("agent-network/package.json").read_text())["version"] != args.version:
        raise ValueError("checked-out main CLI version differs")
    runtime = json.loads(Path("agent-node/package.json").read_text())["version"]
    url = ("https://github.com/sleep2agi/agent-network/releases/download/cli-v"
           + args.version + "/" + packages[0].name)
    print("# Official gated CLI download\n")
    print(f"Main source `{args.commit}`, release.yml run `{args.run_id}`; build and all four gates SUCCESS.")
    print(f"Inner tarball SHA256 `{args.sha256}`. No npm publish or dist-tag change in this workflow.")
    print("\n## Install\n")
    print(f"Install the CLI `{args.version}` tarball from {url} with npm into a chosen private prefix;")
    print(f"install the exact paired `@sleep2agi/agent-node@{runtime}` there as well.")
    print("\n## Upgrade\n")
    print("Follow docs-site/docs/deploy/daemon.md: retain the old private pair/config, wait for idle,")
    print("switch only the requested Daemon, verify actual processes and fresh Hub heartbeat, or roll back.")
    print("No business node/account/session is automatically switched. Not a native installer or live OAuth proof.")


if __name__ == "__main__":
    main()
