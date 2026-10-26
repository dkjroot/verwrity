"""Atomic publication of local project files."""

import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock


# The local server serializes mutation and publication through the same lock.
PROJECT_LOCK = RLock()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix=".saving-", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(data)
            temporary.flush()
            os.fsync(temporary.fileno())
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
