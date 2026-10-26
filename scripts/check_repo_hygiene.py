"""Offline publication checks. Run from any directory; no third-party packages."""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]


def git(*args: str, data: str | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args], input=data,
        text=True, encoding="utf-8", capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def check() -> list[str]:
    errors = []
    tracked = set(git("ls-files", "-z").split("\0")) - {""}
    candidates = set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")) - {""}
    ignored_tracked = git("ls-files", "--cached", "--ignored", "--exclude-standard").splitlines()
    errors.extend(f"Tracked despite ignore rule: {name}" for name in ignored_tracked)

    required_ignored = [
        "AGENTS.md", "DEVELOPMENT.md", "agent_docs/probe.md",
        "nested/AGENTS.md", "user_files/local-user/probe.json",
        ".test-runtime/probe.png", "test-results/probe.png",
        "playwright-report/index.html", "artifacts/probe.png",
        "debug.log", "debug.log.1", "nested/test.log", ".env", ".env.local",
        "node_modules/probe.js", "venv/probe.py", ".venv/probe.py",
        "__pycache__/probe.pyc", ".pytest_cache/probe", ".coverage",
        "coverage.xml", "build/probe", "dist/probe", ".codex/probe",
        ".gitignore~", "..gitignore.un~", "probe.tmp", "probe.bak",
        "probe.verwrity.zip", "probe.fingal.json",
        "models/probe.bin", "probe.gguf", "probe.onnx", "probe.safetensors",
    ]
    # --no-index also tests ignored paths still present in an old Git index.
    ignored = set(git("check-ignore", "--no-index", "--stdin", "-z", data="\0".join(required_ignored) + "\0").split("\0"))
    errors.extend(f"Missing ignore rule: {name}" for name in required_ignored if name not in ignored)

    public_assets = [
        "README.md", "LICENSING.md", "license.txt", "package-lock.json",
        "verwrity/web/static/editor.bundle.js", "fixtures/test-story.md",
        "tests/fixtures/fingal-format1.json",
        "user-guides/screenshots/01-writing-workspace.png",
    ]
    result = subprocess.run(
        ["git", "-C", str(ROOT), "check-ignore", "--no-index", "--stdin", "-z"],
        input="\0".join(public_assets) + "\0", text=True, capture_output=True,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip())
    errors.extend(f"Distribution asset is ignored: {name}" for name in result.stdout.split("\0") if name)

    note_name = re.compile(r"^(?:AGENTS|DEVELOPMENT|OBSERVATIONS|TODO|ROADMAP|PROGRESS|HANDOVER|WIKI-AI-IMPLEMENTATION)(?:\.[^.]+)?$|_TODO\.md$", re.I)
    for name in sorted(candidates):
        path = ROOT / name
        if path.suffix.lower() == ".md" and note_name.search(path.name):
            errors.append(f"Agent/planning document would be published: {name}")
        if not path.is_file():
            errors.append(f"Index references missing file: {name}")
            continue
        if path.suffix != ".md":
            continue
        text = path.read_text(encoding="utf-8")
        if re.search(r"\bVerity\b", text, flags=re.I):
            errors.append(f"Incorrect project spelling in: {name}")
        # Validate repository-local Markdown links/images, excluding code fences.
        prose = re.sub(r"```.*?```", "", text, flags=re.S)
        for target in re.findall(r"\]\(([^)]+)\)", prose):
            target = target.split(' "', 1)[0].strip("<>")
            if re.match(r"[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("#"):
                continue
            link_path = unquote(target.split("#", 1)[0])
            resolved = (ROOT / link_path.lstrip("/")) if link_path.startswith("/") else path.parent / link_path
            if not resolved.exists():
                errors.append(f"Broken local link in {name}: {target}")
            elif resolved.resolve().is_relative_to(ROOT):
                relative = resolved.resolve().relative_to(ROOT).as_posix()
                if resolved.is_file() and relative not in candidates:
                    errors.append(f"Public link points to ignored/local file in {name}: {target}")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if re.search(r"^#{1,3} (?:Development|Engineering guidance|Open design questions|Planned product surface|Architecture at a glance)", readme, re.M):
        errors.append("README contains internal engineering/planning sections")
    if "Free to use. Please help keep it that way." not in readme:
        errors.append("README must retain the free-software request")
    if "Windows PowerShell" not in readme or "Linux" not in readme:
        errors.append("README must document Windows and Linux setup")
    return errors


def main() -> int:
    try:
        errors = check()
    except (OSError, RuntimeError, UnicodeError) as exc:
        print(f"Repository hygiene could not run: {exc}", file=sys.stderr)
        return 1
    if errors:
        print(f"Repository hygiene FAILED ({len(errors)} issues):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Repository hygiene passed: ignore rules, publication files and local documentation links.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
