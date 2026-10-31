"""Reachability checks must not load, lock, save or disclose project data."""
from pathlib import Path
from tempfile import TemporaryDirectory
from http.client import HTTPConnection
from threading import Event, Thread
import unittest
from unittest.mock import patch

from flask import Flask, Response

from verwrity.web.app import create_app, main, make_server


class ServerConnectionTest(unittest.TestCase):
    def test_entry_point_uses_threaded_http_server(self):
        with patch("verwrity.web.app.create_app") as factory, patch("verwrity.web.app.make_server") as server:
            main()
        server.assert_called_once_with("127.0.0.1", 8000, factory.return_value, threaded=True)
        server.return_value.__enter__.return_value.serve_forever.assert_called_once()

    def test_ndjson_and_sse_arrive_before_completion_with_explicit_chunk_framing(self):
        app = Flask(__name__)
        release = Event()

        @app.get("/stream/<kind>")
        def stream(kind):
            def chunks():
                yield b'{"stage":"waiting"}\n' if kind == "ndjson" else b'data: first\n\n'
                if not release.wait(5):
                    raise RuntimeError("Test did not release the stream")
                yield b'{"result":"done"}\n' if kind == "ndjson" else b'data: done\n\n'
            return Response(chunks(), mimetype="application/x-ndjson" if kind == "ndjson" else "text/event-stream")

        @app.get("/health")
        def health():
            return "ok"

        with make_server("127.0.0.1", 0, app, threaded=True) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for kind in ("ndjson", "sse"):
                    with self.subTest(kind=kind):
                        release.clear()
                        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                        try:
                            connection.request("GET", f"/stream/{kind}")
                            response = connection.getresponse()
                            self.assertEqual(response.version, 11)
                            self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
                            self.assertIsNone(response.getheader("Content-Length"))
                            first = response.readline()
                            self.assertIn(b"waiting" if kind == "ndjson" else b"first", first)
                            self.assertFalse(release.is_set(), "First event arrives while the stream is still open")
                            probe = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                            try:
                                probe.request("GET", "/health")
                                self.assertEqual(probe.getresponse().read(), b"ok")
                            finally:
                                probe.close()
                            release.set()
                            self.assertIn(b"done", response.read())
                        finally:
                            release.set()
                            connection.close()
            finally:
                release.set()
                server.shutdown()
                thread.join(timeout=5)

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
