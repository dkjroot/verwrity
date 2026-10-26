"""Exercise the publication audit against disposable Git repositories."""

from pathlib import Path
from contextlib import redirect_stderr
from io import StringIO
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import check_repo_hygiene as hygiene


class RepoHygieneTests(unittest.TestCase):
    def setUp(self):
        runtime = hygiene.ROOT / ".test-runtime"
        runtime.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=runtime)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        (self.root / ".gitignore").write_bytes((hygiene.ROOT / ".gitignore").read_bytes())
        (self.root / "README.md").write_text(
            "# Verwrity\n\nFree to use. Please help keep it that way.\n\n"
            "Windows PowerShell and Linux setup.\n", encoding="utf-8",
        )
        self.git("add", ".gitignore", "README.md")
        self.scope = patch.object(hygiene, "ROOT", self.root)
        self.scope.start()
        self.addCleanup(self.scope.stop)

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.root), *args], capture_output=True, text=True)
        if result.returncode:
            self.fail(result.stderr)

    def test_clean_checkout_and_deliberate_assets(self):
        self.assertEqual(hygiene.check(), [])

    def test_human_introduction_can_precede_the_free_software_request(self):
        readme = self.root / "README.md"
        intro = "# Verwrity\n\n" + "A human introduction.\n\n" * 8
        readme.write_text(intro + readme.read_text(encoding="utf-8"), encoding="utf-8")
        self.assertEqual(hygiene.check(), [])

    def test_missing_ignore_rule_is_reported(self):
        path = self.root / ".gitignore"
        path.write_text(path.read_text(encoding="utf-8").replace("*.log\n", ""), encoding="utf-8")
        self.assertIn("Missing ignore rule: debug.log", hygiene.check())

    def test_force_tracked_log_is_reported(self):
        (self.root / "debug.log").write_text("synthetic diagnostic", encoding="utf-8")
        self.git("add", "-f", "debug.log")
        self.assertIn("Tracked despite ignore rule: debug.log", hygiene.check())

    def test_links_to_missing_and_private_notes_are_reported(self):
        (self.root / "AGENTS.md").write_text("local instructions", encoding="utf-8")
        with (self.root / "README.md").open("a", encoding="utf-8") as stream:
            stream.write("[Missing](missing.md) and [Private](AGENTS.md)\n")
        errors = hygiene.check()
        self.assertIn("Broken local link in README.md: missing.md", errors)
        self.assertIn("Public link points to ignored/local file in README.md: AGENTS.md", errors)

    def test_misplaced_planning_document_is_reported(self):
        (self.root / "ROADMAP.md").write_text("local plan", encoding="utf-8")
        self.assertIn("Agent/planning document would be published: ROADMAP.md", hygiene.check())

    def test_runner_returns_nonzero_and_diagnostics_on_failure(self):
        (self.root / "TODO.md").write_text("local tasks", encoding="utf-8")
        output = StringIO()
        with redirect_stderr(output):
            self.assertEqual(hygiene.main(), 1)
        self.assertIn("TODO.md", output.getvalue())


if __name__ == "__main__":
    unittest.main()
