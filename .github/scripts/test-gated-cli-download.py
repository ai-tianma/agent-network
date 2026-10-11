import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("verify-gated-cli-download.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Gates(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.run = dict(id=123, head_sha=self.sha, head_branch="main", event="workflow_dispatch",
                        path=".github/workflows/release.yml")
        self.jobs = {"jobs": [dict(name=name, conclusion="success") for name in guard.GATES]}

    def test_exact_official_main_run(self):
        guard.validate_run(self.run, self.jobs, self.sha, "123")

    def test_other_source_or_branch_rejected(self):
        for patch in ({"head_sha": "b" * 40}, {"head_branch": "feature"}, {"event": "pull_request"},
                      {"path": ".github/workflows/other.yml"}, {"id": 124}):
            with self.assertRaises(ValueError):
                guard.validate_run(self.run | patch, self.jobs, self.sha, "123")

    def test_every_gate_required(self):
        for i in range(len(guard.GATES)):
            jobs = copy.deepcopy(self.jobs)
            jobs["jobs"][i]["conclusion"] = "failure"
            with self.assertRaises(ValueError):
                guard.validate_run(self.run, jobs, self.sha, "123")

    def test_short_sha_rejected(self):
        with self.assertRaises(ValueError):
            guard.validate_run(self.run, self.jobs, "a" * 7, "123")


if __name__ == "__main__":
    unittest.main()
