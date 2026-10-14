# -*- coding: utf-8 -*-
"""Local HTTP server for the browser viewer.

Serves the viewer (``web/``) at ``/`` and the exported scene folder at
``/scene/``. The viewer posts analysis results and feature picks back; they
are queued here and collected by QGIS on its own thread, because the server
thread must never touch QGIS objects.

Binds to 127.0.0.1 only.
"""
from __future__ import annotations

import functools
import http.server
import json
import mimetypes
import os
import posixpath
import socket
import socketserver
import threading
import urllib.parse
from pathlib import Path

RESULT_ENDPOINT = "/api/result"
SELECT_ENDPOINT = "/api/select"
SELECTION_ENDPOINT = "/api/selection"
PING_ENDPOINT = "/api/ping"
SCENE_PREFIX = "/scene/"

MAX_RESULT_BYTES = 512 * 1024 * 1024
MAX_SELECT_BYTES = 4 * 1024 * 1024
MAX_QUEUE = 64


class Bridge:
    """Thread-safe hand-over between the server thread and the QGIS thread."""

    def __init__(self):
        self._lock = threading.Lock()
        self._results: list = []
        self._picks: list = []
        self._selection_seq = 0
        self._selection: dict = {}

    # viewer -> QGIS
    def push_result(self, payload: dict) -> None:
        with self._lock:
            self._results.append(payload)
            del self._results[:-MAX_QUEUE]

    def pop_results(self) -> list:
        with self._lock:
            out, self._results = self._results, []
            return out

    def push_pick(self, payload: dict) -> None:
        with self._lock:
            self._picks.append(payload)
            del self._picks[:-MAX_QUEUE]

    def pop_picks(self) -> list:
        with self._lock:
            out, self._picks = self._picks, []
            return out

    # QGIS -> viewer
    def set_selection(self, selection: dict) -> int:
        clean = {}
        for layer_id, ids in (selection or {}).items():
            try:
                clean[str(layer_id)] = [int(i) for i in list(ids)[:5000]]
            except (TypeError, ValueError):
                continue
        with self._lock:
            self._selection_seq += 1
            self._selection = clean
            return self._selection_seq

    def selection(self) -> dict:
        with self._lock:
            return {"seq": self._selection_seq, "layers": dict(self._selection)}


class ViewerHandler(http.server.SimpleHTTPRequestHandler):
    """Static files plus a small JSON API. Logging is silenced."""

    def log_message(self, fmt, *args):  # noqa: D401 - silence the access log
        return

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ------------------------------------------------------------ static
    def translate_path(self, path):
        scene_dir = getattr(self.server, "scene_dir", None)
        clean = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        if clean.startswith(SCENE_PREFIX) and scene_dir:
            rel = posixpath.normpath(clean[len(SCENE_PREFIX):]).lstrip("/")
            root = Path(scene_dir).resolve()
            target = (root / rel).resolve()
            if target == root or root in target.parents:
                return str(target)
            return str(root / "__forbidden__")
        return super().translate_path(path)

    # ------------------------------------------------------------ API
    def _bridge(self) -> Bridge | None:
        return getattr(self.server, "bridge", None)

    def do_GET(self):  # noqa: N802 (http.server naming)
        route = self.path.split("?", 1)[0]
        if route == PING_ENDPOINT:
            self._send_json(200, {"ok": True, "version": getattr(self.server, "version", "")})
            return
        if route == SELECTION_ENDPOINT:
            bridge = self._bridge()
            self._send_json(200, bridge.selection() if bridge else {"seq": 0, "layers": {}})
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802 (http.server naming)
        route = self.path.split("?", 1)[0]
        bridge = self._bridge()
        if bridge is None or route not in (RESULT_ENDPOINT, SELECT_ENDPOINT):
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        limit = MAX_RESULT_BYTES if route == RESULT_ENDPOINT else MAX_SELECT_BYTES
        payload, error = self._read_json(limit)
        if error:
            self._send_json(400, {"ok": False, "error": error})
            return
        if route == RESULT_ENDPOINT:
            bridge.push_result(payload)
        else:
            bridge.push_pick(payload)
        self._send_json(200, {"ok": True})

    def _read_json(self, limit: int):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > limit:
            return None, "missing or oversized body"
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            return None, f"bad JSON: {exc}"
        if not isinstance(payload, dict):
            return None, "payload must be a JSON object"
        return payload, ""

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True


class ViewerServer:
    """Start/stop wrapper; finds a free port in a small range."""

    def __init__(self, web_root: str, host: str = "127.0.0.1",
                 start_port: int = 8640, end_port: int = 8679, version: str = ""):
        self.web_root = str(web_root)
        self.host = host
        self.start_port = start_port
        self.end_port = end_port
        self.version = version
        self.port: int | None = None
        self.bridge = Bridge()
        self._httpd = None
        self._thread = None
        self._scene_dir = ""
        mimetypes.add_type("application/javascript", ".js")
        mimetypes.add_type("application/javascript", ".mjs")
        mimetypes.add_type("application/json", ".json")
        mimetypes.add_type("application/json", ".geojson")
        mimetypes.add_type("application/octet-stream", ".bin")
        mimetypes.add_type("text/plain", ".epw")

    @property
    def is_running(self) -> bool:
        return self._httpd is not None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}/" if self.port else ""

    def set_scene_dir(self, path: str) -> None:
        self._scene_dir = str(path or "")
        if self._httpd is not None:
            self._httpd.scene_dir = self._scene_dir

    def viewer_url(self) -> str:
        if not self.is_running:
            return ""
        return f"{self.base_url}index.html?scene={urllib.parse.quote(SCENE_PREFIX + 'scene.json')}"

    def start(self) -> str:
        if self.is_running:
            return self.viewer_url()
        handler = functools.partial(ViewerHandler, directory=self.web_root)
        last_error: Exception | None = None
        for port in range(self.start_port, self.end_port + 1):
            if _port_in_use(self.host, port):
                continue
            try:
                httpd = _ThreadingServer((self.host, port), handler)
            except OSError as exc:
                last_error = exc
                continue
            httpd.bridge = self.bridge
            httpd.scene_dir = self._scene_dir
            httpd.version = self.version
            self._httpd = httpd
            self.port = port
            break
        if self._httpd is None:
            raise OSError(f"No free local port in {self.start_port}-{self.end_port}: {last_error}")
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        name="Geo3DViewerServer", daemon=True)
        self._thread.start()
        return self.viewer_url()

    def stop(self) -> None:
        if self._httpd is None:
            return
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._httpd = None
        self._thread = None
        self.port = None


def _port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) == 0


def web_root_for(plugin_dir: str) -> str:
    return os.path.join(plugin_dir, "web")
