"""Application factory and development server entry point."""

from werkzeug.serving import make_server
import os
import logging
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from flask import Flask, g, request

from verwrity.web.routes.dialogue import dialogue_blueprint, dialogue_ai_blueprint
from verwrity.web.routes.scene_structure import structure_blueprint
from verwrity.project.store import ProjectStore
from verwrity.analysis.spelling import SpellChecker
from verwrity.analysis.thesaurus import Thesaurus
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.ai.settings import UserAISettings
from verwrity.ai.llm import LLMRegistry
from verwrity.ai.tts import TTSRegistry
from verwrity.ai.stt import STTRegistry
from verwrity.ai.ocr import OCRRegistry
from verwrity.ai.ocr_worker import OCRWorker
from verwrity.web.routes.ocr import ocr_blueprint
from verwrity.web.routes.import_vocabulary import vocabulary_blueprint
from verwrity.web.services.persistence import configure_project_persistence
from verwrity.web.routes.ai import ai_blueprint
from verwrity.web.routes.dictate_draft import draft_blueprint
from verwrity.web.routes.analysis import analysis_blueprint
from verwrity.web.routes.projects import project_blueprint
from verwrity.web.routes.scenes import scene_blueprint
from verwrity.web.routes.storyboard import storyboard_blueprint
from verwrity.web.routes.workspace import workspace_blueprint
from verwrity.web.routes.wiki import wiki_blueprint
from verwrity.web.routes.world import world_blueprint
from verwrity.web.routes.fingal import fingal_blueprint


def configure_logging() -> None:
    """Show application stages without enabling verbose third-party payload logs."""
    logger = logging.getLogger("verwrity")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(threadName)s]: %(message)s", datefmt="%H:%M:%S"))
        logger.addHandler(handler)


def create_app(project_store: ProjectStore | None = None) -> Flask:
    """Create the Flask application with its feature Blueprints registered."""
    configure_logging()
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("VERWRITY_SECRET_KEY", "development-only-change-me")
    app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
    app.config["MAX_FORM_PARTS"] = 10_000
    for name, default in (("PATREON", ""),
                          ("COFFEE", "https://buymeacoffee.com/dkjroot"),
                          ("KICKSTARTER", "")):
        app.config[f"SUPPORT_{name}_URL"] = os.environ.get(f"VERWRITY_SUPPORT_{name}_URL", default)
    app.config["INITIAL_PROJECT"] = project_store.get() if project_store else ProjectStore().get()
    app.config["PROJECT_STORES"] = {}
    app.config["PROJECT_DRAFT_ROOT"] = Path("user_files")
    app.config["PROJECT_LIBRARY"] = ProjectLibrary()
    # Placeholder until authentication exists; all storage is already user-scoped.
    app.config["USER_ID"] = "local-user"
    app.extensions["user_preferences"] = UserPreferences(app.config["PROJECT_LIBRARY"].root)
    app.extensions["text_analyses"] = UserTextAnalyses(app.config["PROJECT_LIBRARY"].root)
    app.extensions["ai_settings"] = UserAISettings(app.config["PROJECT_LIBRARY"].root)
    app.extensions["tts_registry"] = TTSRegistry()
    app.extensions["llm_registry"] = LLMRegistry()
    app.extensions["stt_registry"] = STTRegistry()
    app.extensions["ocr_registry"] = OCRRegistry()
    app.extensions["ocr_worker"] = OCRWorker()
    app.extensions["spell_checker"] = SpellChecker()
    app.extensions["thesaurus"] = Thesaurus()
    app.register_blueprint(workspace_blueprint)
    app.register_blueprint(wiki_blueprint)
    app.register_blueprint(world_blueprint)
    app.register_blueprint(fingal_blueprint)
    app.register_blueprint(scene_blueprint)
    app.register_blueprint(dialogue_blueprint)
    app.register_blueprint(dialogue_ai_blueprint)
    app.register_blueprint(structure_blueprint)
    app.register_blueprint(storyboard_blueprint)
    app.register_blueprint(project_blueprint)
    app.register_blueprint(analysis_blueprint)
    app.register_blueprint(ai_blueprint)
    app.register_blueprint(draft_blueprint)
    app.register_blueprint(ocr_blueprint)
    app.register_blueprint(vocabulary_blueprint)

    configure_project_persistence(app)

    @app.before_request
    def begin_workspace_operation():
        endpoint = request.endpoint or ""
        if endpoint.startswith("projects.") or endpoint in {"analysis.spell_check_scene", "analysis.text_analysis_scene"}:
            g.workspace_operation = endpoint
            g.workspace_request_id = uuid4().hex[:8]
            g.workspace_started = perf_counter()
            app.logger.info("%s [%s] started", endpoint, g.workspace_request_id)

    @app.after_request
    def finish_workspace_operation(response):
        if hasattr(g, "workspace_operation"):
            log = app.logger.info if response.status_code < 400 else app.logger.warning
            log("%s [%s] response in %.2fs (HTTP %s)", g.workspace_operation,
                g.workspace_request_id, perf_counter() - g.workspace_started, response.status_code)
        return response

    @app.teardown_request
    def workspace_operation_error(error):
        if error is not None and hasattr(g, "workspace_operation"):
            # Exception bodies can contain filenames or source text.
            app.logger.error("%s [%s] failed (%s)", g.workspace_operation,
                             g.workspace_request_id, type(error).__name__)

    return app


def main() -> None:
    port = 8000
    app = create_app()
    app.logger.info("Verwrity starting at http://127.0.0.1:%s", port)
    # Threaded Werkzeug serves HTTP/1.1 with chunked response framing. This
    # supports incremental NDJSON/SSE without relying on connection closure.
    with make_server("127.0.0.1", port, app, threaded=True) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
