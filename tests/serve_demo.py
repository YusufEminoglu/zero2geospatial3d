# -*- coding: utf-8 -*-
"""Serve the viewer with a scene folder through the plugin's own server
(no QGIS). Prints the URL and keeps running; results posted by the viewer
are printed as they arrive.

    py -3 tests/serve_demo.py <scene_dir> [first_port]

The port search starts at 8660 by default, clear of 8640 where a running
QGIS plugin serves its own viewer.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)


def load_server():
    spec = importlib.util.spec_from_file_location("g3d_server", os.path.join(PLUGIN, "core", "server.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    server_mod = load_server()
    first = int(sys.argv[2]) if len(sys.argv) > 2 else 8660
    server = server_mod.ViewerServer(os.path.join(PLUGIN, "web"), start_port=first, end_port=first + 19, version="demo")
    server.set_scene_dir(sys.argv[1])
    print(server.start(), flush=True)
    try:
        while True:
            for payload in server.bridge.pop_results():
                print("RESULT", payload.get("type"), payload.get("name") or payload.get("layer"),
                      sorted((payload.get("fields") or {}).keys()), flush=True)
            for payload in server.bridge.pop_picks():
                print("PICK", payload, flush=True)
            time.sleep(0.3)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
