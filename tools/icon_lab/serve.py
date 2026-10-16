# -*- coding: utf-8 -*-
"""Render the plugin icons with three.js (studio light, soft shadows, PBR).

    py -3 tools/icon_lab/serve.py

then open http://127.0.0.1:8690/index.html in a browser and run
``renderIcons()`` in its console: icons/icon.png and icons/quick3d.png are
rendered at 1600 px, cropped to the drawn pixels (no margin, transparent
background) and saved at 512 px. Development only; not part of the plugin zip.
"""
import base64
import http.server
import os
import sys
import urllib.parse

LAB = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(os.path.dirname(LAB))
VENDOR = os.path.join(PLUGIN, "web", "vendor")
OUT = os.path.join(PLUGIN, "icons")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = urllib.parse.urlparse(path).path
        if path.startswith("/vendor/"):
            return os.path.join(VENDOR, *path[len("/vendor/"):].split("/"))
        return os.path.join(LAB, *path.lstrip("/").split("/"))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        name = os.path.basename(q.get("name", ["render.png"])[0])
        if name not in ("icon.png", "quick3d.png"):
            self.send_response(400)
            self.end_headers()
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("ascii").split(",", 1)[-1]
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(base64.b64decode(data))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8690
    print(f"http://127.0.0.1:{port}/index.html")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
