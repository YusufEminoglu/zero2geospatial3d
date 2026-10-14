# -*- coding: utf-8 -*-
"""EnergyPlus weather (EPW) files: header check, nearest-station lookup and
download from climate.onebuilding.org (TMYx files).

The station index ``data/epw_stations.json.gz`` is built by
``tools/build_epw_index.py`` from OneBuilding's published KML indexes.
"""
from __future__ import annotations

import gzip
import io
import json
import math
import os
import zipfile

INDEX_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "epw_stations.json.gz")
MAX_ZIP_BYTES = 40 * 1024 * 1024


class EpwError(RuntimeError):
    pass


def read_header(path: str) -> dict:
    """Parse the LOCATION line of an EPW file: city, country, lat, lon, tz, elevation."""
    try:
        with open(path, "r", encoding="latin-1") as handle:
            first = handle.readline()
    except OSError as exc:
        raise EpwError(f"Cannot read {path}: {exc}") from exc
    parts = [p.strip() for p in first.split(",")]
    if len(parts) < 10 or parts[0].upper() != "LOCATION":
        raise EpwError("Not an EPW file (the first line is not a LOCATION record).")
    try:
        return {"city": parts[1], "region": parts[2], "country": parts[3], "source": parts[4],
                "wmo": parts[5], "lat": float(parts[6]), "lon": float(parts[7]),
                "utc": float(parts[8]), "elevation": float(parts[9])}
    except ValueError as exc:
        raise EpwError(f"Malformed EPW LOCATION line: {exc}") from exc


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0088 * 2 * math.asin(min(1.0, math.sqrt(a)))


def load_index(path: str = INDEX_PATH) -> dict:
    if not os.path.isfile(path):
        raise EpwError("The weather-station index is missing from the plugin.")
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def nearest_stations(lat: float, lon: float, count: int = 5, index: dict | None = None) -> list:
    """The ``count`` nearest stations as dicts sorted by distance."""
    index = index or load_index()
    base = index.get("base", "")
    scored = []
    for lat_s, lon_s, station, path, utc, elev in index["rows"]:
        scored.append((haversine_km(lat, lon, lat_s, lon_s), lat_s, lon_s, station, path, utc, elev))
    scored.sort(key=lambda row: row[0])
    return [{"distance_km": round(d, 1), "lat": la, "lon": lo, "station": st, "url": base + p,
             "utc": utc, "elevation": el} for d, la, lo, st, p, utc, el in scored[:count]]


def extract_epw(zip_bytes: bytes, target_path: str) -> str:
    """Write the single .epw member of a OneBuilding zip to ``target_path``."""
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise EpwError("The weather archive is unexpectedly large.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise EpwError("The download is not a zip archive.") from exc
    members = [m for m in archive.infolist() if m.filename.lower().endswith(".epw")]
    if not members:
        raise EpwError("The archive contains no .epw file.")
    member = members[0]
    if member.file_size > MAX_ZIP_BYTES:
        raise EpwError("The weather file is unexpectedly large.")
    data = archive.read(member)
    os.makedirs(os.path.dirname(target_path) or ".", exist_ok=True)
    with open(target_path, "wb") as handle:
        handle.write(data)
    read_header(target_path)
    return target_path


def download_station(url: str, target_path: str) -> str:
    """Download a OneBuilding zip through QGIS's network stack and extract its EPW."""
    from qgis.PyQt.QtCore import QUrl
    from qgis.PyQt.QtNetwork import QNetworkRequest
    from qgis.core import QgsBlockingNetworkRequest

    from .qgis_compat import enum_value

    if not url.startswith("https://climate.onebuilding.org/"):
        raise EpwError("Only climate.onebuilding.org downloads are allowed.")
    request = QNetworkRequest(QUrl(url))
    if hasattr(request, "setTransferTimeout"):
        request.setTransferTimeout(120000)
    client = QgsBlockingNetworkRequest()
    code = client.get(request, False, None)
    if enum_value(code) != enum_value(QgsBlockingNetworkRequest.NoError):
        raise EpwError(f"Download failed: {client.errorMessage()}")
    content = bytes(client.reply().content())
    return extract_epw(content, target_path)
