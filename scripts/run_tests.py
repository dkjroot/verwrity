"""Run Python regression checks with disposable files inside the checkout.

Windows: venv/Scripts/python.exe scripts/run_tests.py
Linux: venv/bin/python scripts/run_tests.py
Append dotted test module names to run a focused selection.
"""

import argparse
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    sys.path.insert(0, str(ROOT))
    runtime = ROOT / ".test-runtime"
    runtime.mkdir(exist_ok=True)
    tempfile.tempdir = str(runtime)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("tests", nargs="*", help="Dotted test module or method names")
    args = parser.parse_args()
    loader = unittest.TestLoader()
    suite = (loader.loadTestsFromNames(args.tests) if args.tests
             else loader.discover(str(ROOT / "tests"), top_level_dir=str(ROOT)))
    result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
    if result.wasSuccessful():
        print(f"PASS: {result.testsRun} Python checks ({len(result.skipped)} skipped).")
        return 0
    print(f"FAIL: {len(result.failures)} failures, {len(result.errors)} errors.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
