from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verwrity.analysis.thesaurus import Thesaurus, DATA_PATH, _index
from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class ThesaurusTest(unittest.TestCase):
    def test_bundled_words_preserve_senses_and_relation_labels(self):
        thesaurus = Thesaurus()
        happy = thesaurus.lookup(" HAPPY ")
        self.assertEqual(happy["word"], "happy")
        self.assertTrue(happy["senses"])
        self.assertTrue(any(term["text"] == "unhappy" and term["relation"] == "antonym"
                            for sense in happy["senses"] for term in sense["terms"]))
        self.assertTrue(any(term["relation"] == "synonym"
                            for sense in thesaurus.lookup("quiet")["senses"] for term in sense["terms"]))
        self.assertGreater(len(thesaurus.lookup("bank")["senses"]), 1)
        self.assertTrue(thesaurus.lookup("ice cream")["senses"])
        self.assertEqual(thesaurus.lookup("zzunfindablewordzz")["senses"], [])

    def test_utf8_byte_offsets_and_concurrent_lookups(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.dat"
            path.write_bytes("UTF-8\ncafé|1\n(noun)|coffeehouse|building (generic term)\ncalm|2\n(adj)|quiet|agitated (antonym)\n(verb)|soothe|relax (similar term)\n".encode("utf-8"))
            thesaurus = Thesaurus(path)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(thesaurus.lookup, ["café", "calm"] * 20))
            self.assertEqual(results[0]["senses"][0]["terms"][0]["text"], "coffeehouse")
            self.assertEqual(results[1]["senses"][1]["terms"][1]["relation"], "similar term")
            self.assertEqual(results[1]["senses"][0]["terms"][1]["relation"], "antonym")
        _index.cache_clear()

    def test_invalid_queries_are_bounded(self):
        for query in (None, [], {}, "", " ", "a" * 81, "<script>", "two\nwords", "123"):
            with self.subTest(query=query), self.assertRaises(ValueError):
                Thesaurus().lookup(query)

    def test_route_is_read_only_local_and_does_not_require_project_or_provider(self):
        project = StoryProject.demo()
        before = export_project(project)[1]
        app = create_app(ProjectStore(project))
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory)
            client = app.test_client()
            with patch("verwrity.web.routes.analysis.active_store", side_effect=AssertionError("Lookup must not read or save a project")), patch.object(app.extensions["llm_registry"], "get", side_effect=AssertionError("No AI")):
                self.assertTrue(client.post("/thesaurus", json={"word": "happy"}).json["senses"])
                self.assertEqual(client.post("/thesaurus", json={"word": "zzunfindablewordzz"}).json["senses"], [])
                for payload in ({}, [], {"word": 2}, {"word": "x" * 81}):
                    self.assertEqual(client.post("/thesaurus", json=payload).status_code, 400)
                self.assertEqual(client.get("/thesaurus?word=happy").status_code, 405)
            with patch.object(app.extensions["thesaurus"], "lookup", side_effect=OSError("private path")):
                response = client.post("/thesaurus", json={"word": "happy"})
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("private path", response.get_data(as_text=True))
        self.assertEqual(export_project(project)[1], before)

    def test_data_and_licence_are_distributed_together(self):
        self.assertGreater(DATA_PATH.stat().st_size, 10_000_000)
        self.assertIn("Copyright 2005 by Princeton University", DATA_PATH.with_name("WordNet_license.txt").read_text())


if __name__ == "__main__":
    unittest.main()
