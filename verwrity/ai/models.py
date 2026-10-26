"""Pinned, integrity-checked downloads for optional local AI model files."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


class ModelDownloadError(RuntimeError):
    """A model asset could not be downloaded and verified."""


@dataclass(frozen=True)
class ModelAsset:
    filename: str
    size: int
    sha256: str
    url: str


KOKORO_ASSETS = (
    ModelAsset(
        "kokoro-v1.0.onnx", 325_532_387,
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    ),
    ModelAsset(
        "voices-v1.0.bin", 28_214_398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    ),
)


class KokoroModelInstaller:
    """Install the fixed Kokoro release into an app-managed local directory."""

    def __init__(self, root: Path | str, assets: tuple[ModelAsset, ...] = KOKORO_ASSETS) -> None:
        self.root = Path(root)
        self.assets = assets

    def ready(self) -> bool:
        # Keep ordinary settings reads cheap; full hashes are checked when a
        # download is requested and before any existing file is accepted there.
        try:
            return all(
                (path := self.root / asset.filename).is_file()
                and path.stat().st_size == asset.size
                for asset in self.assets
            )
        except OSError:
            return False

    def install(self) -> dict[str, str]:
        self.root.mkdir(parents=True, exist_ok=True)
        installed: dict[str, str] = {}
        for asset in self.assets:
            target = self.root / asset.filename
            if not self._valid_file(asset, target):
                self._download(asset, target)
            installed[asset.filename] = str(target.resolve())
        return installed

    @staticmethod
    def _valid_file(asset: ModelAsset, path: Path) -> bool:
        try:
            if path.stat().st_size != asset.size:
                return False
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest() == asset.sha256
        except OSError:
            return False

    def _download(self, asset: ModelAsset, target: Path) -> None:
        temporary_path: Path | None = None
        digest = hashlib.sha256()
        received = 0
        try:
            with urlopen(asset.url, timeout=60) as response:
                with NamedTemporaryFile("wb", dir=self.root, prefix=f".{asset.filename}.", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > asset.size:
                            raise ModelDownloadError("Downloaded model file is larger than expected.")
                        digest.update(chunk)
                        temporary.write(chunk)
                    temporary.flush()
                    os.fsync(temporary.fileno())
            if received != asset.size or digest.hexdigest() != asset.sha256:
                raise ModelDownloadError("Downloaded model file failed its size or SHA-256 check.")
            temporary_path.replace(target)
            temporary_path = None
        except ModelDownloadError:
            raise
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise ModelDownloadError("Could not download the Kokoro model files. Check the connection and try again.") from error
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
