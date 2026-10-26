# -*- coding: utf-8 -*-
"""Build docs/MANUAL.md, the GitHub-readable copy of the reference manual,
from docs/index.html (the styled manual served at geophilo.com).

GitHub shows an .html file as source code, so the repository also carries
the manual as Markdown: same text, tables, formulas ($...$ and ```math) and
screenshots. Edit docs/index.html, then run (needs pandoc on PATH):

    python tools/build_manual_md.py
"""
from __future__ import annotations

import re
import shutil
# Runs the local pandoc binary on a repository file.
import subprocess  # nosec B404
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "index.html"
TARGET = ROOT / "docs" / "MANUAL.md"
ANCHOR = "ZZANCHORZZ"

HEADER = """<!-- Generated from docs/index.html by tools/build_manual_md.py; edit the HTML, then rebuild. -->

> **02 Geo3D Analyzer — Reference Manual** (v{version}). The styled online edition is at
> [geophilo.com/zero2geospatial3d](https://geophilo.com/zero2geospatial3d/); this copy is the same manual
> for reading on GitHub.

"""


def preprocess(html: str) -> str:
    main = html[html.index('<main class="main" id="top">'):html.index("</main>")]
    main = re.sub(r"<footer>.*?</footer>", "", main, flags=re.S)
    # Section and heading ids become explicit anchors (GitHub derives its own
    # from the heading text, which would break the manual's #links).
    main = re.sub(r'<section id="([\w-]+)">', lambda m: f'<section><p>{ANCHOR}{m.group(1)}</p>', main)
    main = re.sub(r'<(h[1-4]) id="([\w-]+)">', lambda m: f'<p>{ANCHOR}{m.group(2)}</p><{m.group(1)}>', main)
    # Eyebrows ("05 · Sun hours") read as an italic line above the heading.
    main = re.sub(r'<div class="eyebrow">(.*?)</div>', r"<p><em>\1</em></p>", main)
    # Card links wrap the whole card; keep the card text and drop the empty link.
    main = re.sub(r'<a class="card" href="(#[\w-]+)">(.*?)</a>', r'<div class="card">\2</div>', main, flags=re.S)
    # Hero stats and badges: one readable line each.
    main = re.sub(r'<div class="stat"><strong>(.*?)</strong><span>(.*?)</span></div>', r"<p><strong>\1</strong> \2</p>", main)
    main = re.sub(r'<div class="hero-badges">(.*?)</div>',
                  lambda m: "<p>" + " · ".join(re.findall(r"<span[^>]*>(.*?)</span>", m.group(1))) + "</p>", main, flags=re.S)
    # Inline MathJax \( ... \) -> a placeholder pandoc leaves alone.
    main = re.sub(r"\\\((.+?)\\\)", lambda m: "ZZMATHZZ" + m.group(1).encode().hex() + "ZZ", main, flags=re.S)
    # Display $$ ... $$ (several per formula box) -> one placeholder per formula.
    main = re.sub(r"\$\$(.+?)\$\$", lambda m: "<p>ZZDISPZZ" + m.group(1).strip().encode().hex() + "ZZ</p>", main,
                  flags=re.S)
    return "<html><body>" + main + "</body></html>"


def postprocess(md: str) -> str:
    md = re.sub(r"ZZMATHZZ([0-9a-f]+)ZZ", lambda m: "$" + bytes.fromhex(m.group(1)).decode().strip() + "$", md)
    md = re.sub(r"ZZDISPZZ([0-9a-f]+)ZZ",
                lambda m: "```math\n" + bytes.fromhex(m.group(1)).decode().strip() + "\n```", md)
    md = re.sub(ANCHOR + r"([\w-]+)", r'<a id="\1"></a>', md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip() + "\n"


def main() -> int:
    pandoc = shutil.which("pandoc")
    if not pandoc:
        print("pandoc is not on PATH", file=sys.stderr)
        return 1
    html = SOURCE.read_text(encoding="utf-8")
    version = re.search(r'<div class="version-pill">v([\d.]+)', html).group(1)
    md = subprocess.run([pandoc, "-f", "html", "-t", "gfm-raw_html", "--wrap=none"],  # nosec B603
                        input=preprocess(html), capture_output=True, text=True, check=True).stdout
    # pandoc drops raw HTML; anchors are re-inserted after conversion.
    TARGET.write_text(HEADER.format(version=version) + postprocess(md), encoding="utf-8")
    print(f"Wrote {TARGET.relative_to(ROOT)} ({TARGET.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
