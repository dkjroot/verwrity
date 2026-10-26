import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class WsgiTest(unittest.TestCase):
    def test_home_contains_three_panels_and_source_manuscript(self) -> None:
        project = StoryProject.demo()
        with TemporaryDirectory() as directory:
            app = create_app(ProjectStore(project))
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            response = app.test_client().get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Storyboard", response.data)
        self.assertIn(b"Manuscript", response.data)
        self.assertIn(b"Wiki", response.data)
        self.assertIn(b"Write the opening scene here", response.data)
        self.assertIn(b"Toggle dark mode", response.data)

    def test_unknown_path_is_not_found(self) -> None:
        response = create_app().test_client().get("/missing")
        self.assertEqual(response.status_code, 404)

    def test_workspace_logs_report_progress_and_errors_without_source_or_filenames(self):
        project = StoryProject.demo()
        app = create_app(ProjectStore(project))
        app.config["PROJECT_LIBRARY"] = Mock()
        app.config["PROJECT_LIBRARY"].load.side_effect = ValueError("private-archive-name private-error-body")
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            client = app.test_client()
            with self.assertLogs("verwrity", level="INFO") as logs:
                response = client.post("/project/library-open", data={"project_filename": "private-archive-name"})
                with patch.object(app.extensions["spell_checker"], "analyze") as analyze:
                    analyze.return_value.annotations = ()
                    analyze.return_value.as_dict.return_value = {"annotations": []}
                    spelling = client.post(f"/scene/{project.scenes[0].id}/spell-check", data={"scene_text": "private-manuscript"})
            self.assertEqual(response.status_code, 302)
            self.assertEqual(spelling.status_code, 200)
            output = "\n".join(logs.output)
            for expected in ("started", "response in", "could not be loaded (ValueError)", "Spelling: analyzing", "analysis finished"):
                self.assertIn(expected, output)
            for private in ("private-archive-name", "private-error-body", "private-manuscript"):
                self.assertNotIn(private, output)


if __name__ == "__main__":
    unittest.main()
