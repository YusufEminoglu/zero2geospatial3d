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
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def syntax_errors(node: str) -> list:
    """Parse every viewer module. `node --check file.js` is no check at all
    for ES modules: it tries CommonJS, meets `import`, and exits 0 without
    parsing the module. A copy named .mjs is parsed as a module."""
    src = os.path.join(os.path.dirname(HERE), "web", "src")
    errors = []
    with tempfile.TemporaryDirectory() as tmp:
        for root, _dirs, names in os.walk(src):
            for name in names:
                if not name.endswith(".js"):
                    continue
                path = os.path.join(root, name)
                copy = os.path.join(tmp, "check.mjs")
                shutil.copyfile(path, copy)
                proc = subprocess.run([node, "--check", copy], capture_output=True, text=True,  # noqa: S603
                                      encoding="utf-8", errors="replace", timeout=60)
                if proc.returncode != 0:
                    detail = next((ln for ln in proc.stderr.splitlines() if "Error" in ln), proc.stderr.strip()[:200])
                    errors.append(f"{os.path.relpath(path, src)}: {detail}")
    return errors


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    node = shutil.which("node")
    if node is None:
        print("FAIL: node is not installed (needed for the viewer tests)")
        return 1
    bad = syntax_errors(node)
    for line in bad:
        print(f"SYNTAX {line}")
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
    ok = proc.returncode == 0 and failed == 0 and passed > 0 and not bad
    print(f"{'PASS' if ok else 'FAIL'}: {passed} passed, {failed} failed (node --test)"
          f"{f'; {len(bad)} module(s) with syntax errors' if bad else ''}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
