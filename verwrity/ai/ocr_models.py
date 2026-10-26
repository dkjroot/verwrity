"""Known local OCR locations, cheap readiness checks and explicit installation."""
from pathlib import Path
import importlib.util
import importlib.metadata
import json
import os
import re

from verwrity.ai.ocr import OCRError, REMOTE_OCR

MODEL_RELEASES = {"olmocr": ("allenai/olmOCR-2-7B-1025", "olmocr2", "qwen2_5_vl"),
    "paddleocr": ("PaddlePaddle/PaddleOCR-VL-1.6", "paddleocr-vl-1.6", "paddleocr_vl")}


def model_issue(path, provider):
    if not path:
        return "No installed OCR model directory configured."
    path = Path(path)
    try:
        config = json.loads((path / "config.json").read_text(encoding="utf-8"))
        if config.get("model_type") != MODEL_RELEASES[provider][2]:
            return "The model directory does not match the selected OCR engine."
        for filename in ("tokenizer.json", "tokenizer_config.json", "preprocessor_config.json"):
            if not (path / filename).is_file():
                return f"The OCR directory is missing {filename}."
        index = path / "model.safetensors.index.json"
        names = set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values()) if index.is_file() else {"model.safetensors"}
        if not names:
            return "The OCR weight index is empty."
        for name in names:
            target = (path / name).resolve()
            if not target.is_relative_to(path.resolve()) or not target.is_file() or target.stat().st_size == 0:
                return "The OCR weights are incomplete. Finish or retry the model download."
    except (OSError, ValueError, KeyError, TypeError):
        return "The OCR directory is missing or has an unreadable configuration/weight index."
    return ""


def managed_directory(root, user, provider):
    return Path(root).resolve() / user / "models" / MODEL_RELEASES[provider][1]


def discovered_directory(root, user, provider):
    release, folder, _ = MODEL_RELEASES[provider]
    # Include the README's original download location. Never scan the disk.
    candidates = [managed_directory(root, user, provider), Path(root).resolve() / "models" / folder]
    cache = Path(os.environ.get("HF_HUB_CACHE", Path.home() / ".cache/huggingface/hub")) / ("models--" + release.replace("/", "--"))
    try:
        revision = (cache / "refs/main").read_text().strip()
        if revision and all(c in "0123456789abcdef" for c in revision):
            candidates.append(cache / "snapshots" / revision)
    except OSError:
        pass
    return next((str(p.resolve()) for p in candidates if not model_issue(p, provider)), "")


def readiness(settings):
    if settings["provider"] in REMOTE_OCR:
        from verwrity.ai.ocr_remote import require_remote_consent
        try:
            require_remote_consent(settings)
            problem = ""
        except OCRError as error:
            problem = str(error)
        return {"configured": not bool(problem), "message": problem or "Online OCR configured. Run the sample JPEG test to verify access and billing.", "torch_version": "not required for online OCR", "tested": False}
    problem = model_issue(settings["model_path"], settings["provider"])
    missing = [name for name in ("torch", "transformers", "PIL") if importlib.util.find_spec(name) is None]
    if missing:
        problem = "Install the local-ocr extra in Verwrity's Python environment. Missing: " + ", ".join(missing) + "."
    try:
        version = importlib.metadata.version("torch")
    except importlib.metadata.PackageNotFoundError:
        version = "not installed"
    cpu_build = "+cpu" in version
    try:
        location = next(iter(importlib.util.find_spec("torch").submodule_search_locations))
        cpu_build |= bool(re.search(r"cuda[^\n=]*=\s*None", (Path(location) / "version.py").read_text()))
    except (AttributeError, TypeError, OSError, StopIteration):
        pass
    if settings["device"] == "cuda" and cpu_build:
        problem = "This PyTorch build is CPU-only. Select CPU or install a CUDA-enabled PyTorch build."
    return {"configured": not bool(problem), "message": problem or "Local files/runtime found. Run the sample test to verify inference.",
        "torch_version": version + (" (CPU-only build)" if cpu_build else ""), "tested": False}


def install(root, user, provider):
    if provider not in MODEL_RELEASES:
        raise OCRError("Choose a supported OCR engine.")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise OCRError("Install the local-ocr extra before downloading OCR weights.") from None
    target = managed_directory(root, user, provider)
    target.mkdir(parents=True, exist_ok=True)
    try:
        # Fixed public release, safetensors only; no downloaded Python is run.
        snapshot_download(MODEL_RELEASES[provider][0], local_dir=str(target), token=False,
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja", "*.model", "LICENSE*", "NOTICE*"],
            local_files_only=False)
    except Exception:
        raise OCRError("OCR model download did not finish. Check the connection/disk space and retry; downloaded files can be reused.") from None
    issue = model_issue(target, provider)
    if issue:
        raise OCRError(issue)
    return str(target)
