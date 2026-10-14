# -*- coding: utf-8 -*-
"""Run the viewer's JavaScript unit tests (node --test). Used by `pf verify`.

Exit code 0 only when node ran and every test passed; prints the summary.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess  # noqa: S404 - development-only test runner, not shipped
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    node = shutil.which("node")
    if node is None:
        print("FAIL: node is not installed (needed for the viewer tests)")
        return 1
    js_dir = os.path.join(HERE, "js")
    files = sorted(os.path.join(js_dir, f) for f in os.listdir(js_dir) if f.endswith(".test.mjs"))
    cmd = [node, "--import", pathlib.Path(js_dir, "register.mjs").as_uri(), "--test", "--test-reporter=spec"] + files
    proc = subprocess.run(cmd, cwd=os.path.dirname(HERE), capture_output=True, text=True,  # noqa: S603
                          encoding="utf-8", errors="replace", timeout=900)
    out = proc.stdout + proc.stderr
    print(out[-6000:])
    passed = failed = 0
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("ℹ pass "):
            passed = int(line.split()[-1])
        elif line.startswith("ℹ fail "):
            failed = int(line.split()[-1])
    ok = proc.returncode == 0 and failed == 0 and passed > 0
    print(f"{'PASS' if ok else 'FAIL'}: {passed} passed, {failed} failed (node --test)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
