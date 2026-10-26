"""Isolated browser-test server; never reads or writes the author's library."""

from pathlib import Path
from tempfile import TemporaryDirectory
from dataclasses import replace
from io import BytesIO
import json
from uuid import uuid4
import zipfile
import os

from verwrity.domain.story import StoryProject
from verwrity.domain.story import WikiPage, WikiRevision
from verwrity.domain.wiki_provenance import WikiAnnotation, WikiEvidence
from verwrity.project.archive import export_project
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.ai.settings import UserAISettings
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


if __name__ == "__main__":
    with TemporaryDirectory(prefix="verwrity-browser-") as directory:
        project = StoryProject.demo()
        sentence = "The river wound through the valley and the evening light settled over the quiet town. "
        # Include a paragraph longer than one page to exercise column fragmentation.
        project.scenes[0].text = "\n\n".join(
            f"Paragraph {index}: " + sentence * (80 if index == 1 else 12)
            for index in range(1, 25)
        )
        app = create_app(ProjectStore(project))
        app.config["TEMPLATES_AUTO_RELOAD"] = True
        app.config["PROJECT_LIBRARY"] = ProjectLibrary(Path(directory))
        app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
        app.extensions["user_preferences"] = UserPreferences(Path(directory))
        app.extensions["text_analyses"] = UserTextAnalyses(Path(directory))
        app.extensions["ai_settings"] = UserAISettings(Path(directory))

        @app.get("/__browser_test__")
        def browser_test_marker():
            return {"isolated": True}

        @app.get("/__browser_test__/wiki_legacy_archive")
        def legacy_wiki_archive():
            from flask import Response
            legacy = StoryProject.demo()
            body = "Legacy 😀 AI paragraph.\r\n\r\nSecond legacy AI paragraph."
            record = WikiAnnotation(uuid4(), "ai_text", 0, len(body), body, uuid4(),
                "legacy-source", "test", "legacy", "2026-10-01", (WikiEvidence(legacy.scenes[0].id, "Write"),))
            legacy.wiki_pages = [WikiPage(uuid4(), "Legacy AI", body,
                revisions=(WikiRevision(uuid4(), "Legacy AI", body, annotations=(record,)),), annotations=(record,)),
                WikiPage(uuid4(), "Legacy human", "Human first.\r\n\r\nHuman second.")]
            output = BytesIO()
            with zipfile.ZipFile(BytesIO(export_project(legacy)[1])) as source, zipfile.ZipFile(output, "w") as target:
                for name in source.namelist():
                    data = source.read(name)
                    if name == "manifest.json":
                        manifest = json.loads(data); manifest["archive_version"] = 3; data = json.dumps(manifest)
                    elif name == "wiki.json":
                        pages = json.loads(data)
                        # A single old-style range, without the new origin field.
                        raw = record.as_dict(); raw.pop("origin")
                        pages[0]["annotations"] = [raw]
                        pages[0]["revisions"][0]["annotations"] = [raw]
                        data = json.dumps(pages)
                    target.writestr(name, data)
            return Response(output.getvalue(), mimetype="application/zip")

        @app.post("/__browser_test__/reset")
        def reset_browser_test_state():
            app.config["PROJECT_STORES"].clear()
            for path in Path(app.config["PROJECT_DRAFT_ROOT"]).rglob("*"):
                if path.is_file():
                    path.unlink()
            user_directory = Path(directory) / app.config["USER_ID"]
            (user_directory / "ai_models.json").unlink(missing_ok=True)
            (user_directory / "text_analyses.json").unlink(missing_ok=True)
            (user_directory / "spelling_dictionary.json").unlink(missing_ok=True)
            (user_directory / "preferences.json").unlink(missing_ok=True)
            for path in (user_directory.glob("*.verwrity.zip") if user_directory.exists() else ()):
                path.unlink()
            return {"reset": True}

        app.run(host="127.0.0.1", port=int(os.environ.get("VERWRITY_TEST_PORT", "8765")), debug=False)
