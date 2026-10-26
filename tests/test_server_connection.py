"""Reachability checks must not load, lock, save or disclose project data."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verwrity.web.app import create_app


class ServerConnectionTest(unittest.TestCase):
    def test_health_is_uncached_and_independent_of_project_persistence(self):
        with TemporaryDirectory() as directory:
            app = create_app()
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory)
            with patch("verwrity.web.services.persistence.active_store", side_effect=AssertionError("Loaded a project")), \
                    patch("verwrity.web.services.persistence.PROJECT_LOCK") as lock:
                client = app.test_client()
                response = client.get("/health")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json, {"service": "verwrity", "status": "ok"})
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertNotIn("Set-Cookie", response.headers)
                self.assertEqual(client.head("/health").status_code, 200)
                lock.acquire.assert_not_called()
            self.assertEqual(app.config["PROJECT_STORES"], {})
            self.assertEqual(list(Path(directory).rglob("*")), [])
