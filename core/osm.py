# -*- coding: utf-8 -*-
"""OpenStreetMap buildings and trees for a scene area (Overpass API).

Requests go through QGIS's own network stack (QgsBlockingNetworkRequest), so
the user's proxy and TLS settings apply. Responses are cached on disk for a
week, keyed by the exact query, because the public servers rate-limit.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import tempfile
import time

from qgis.PyQt.QtCore import QByteArray, QUrl, QUrlQuery
from qgis.PyQt.QtNetwork import QNetworkRequest
from qgis.core import (
    QgsBlockingNetworkRequest,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsFeature,
    QgsGeometry,
    QgsPointXY,
    QgsProject,
    QgsRectangle,
    QgsVectorFileWriter,
    QgsVectorLayer,
    QgsWkbTypes,
)

from . import geo, osm_tags
from .qgis_compat import enum_value

ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
TIMEOUT_S = 90
MAX_RESPONSE_BYTES = 192 * 1024 * 1024
CACHE_TTL_S = 7 * 24 * 3600
MAX_AREA_KM2 = 36.0


class OsmError(RuntimeError):
    pass


def _user_agent() -> str:
    from .. import PLUGIN_VERSION

    return f"zero2geospatial3d/{PLUGIN_VERSION} (QGIS plugin; 02 Geo3D Analyzer)"


def _query(s: float, w: float, n: float, e: float) -> str:
    bbox = f"{s:.7f},{w:.7f},{n:.7f},{e:.7f}"
    return (f"[out:json][timeout:{TIMEOUT_S}];\n(\n"
            f"  way[\"building\"]({bbox});\n"
            f"  relation[\"building\"][\"type\"=\"multipolygon\"]({bbox});\n"
            f"  node[\"natural\"=\"tree\"]({bbox});\n"
            f");\nout body geom;")


def _cache_path(query: str) -> str:
    folder = os.path.join(tempfile.gettempdir(), "zero2geospatial3d_osm_cache")
    with contextlib.suppress(OSError):
        os.makedirs(folder, exist_ok=True)
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()[:40]
    return os.path.join(folder, f"{digest}.json")


def _read_cache(query: str):
    path = _cache_path(query)
    if not os.path.isfile(path) or time.time() - os.path.getmtime(path) > CACHE_TTL_S:
        return None
    with contextlib.suppress(OSError, ValueError):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return None


def _write_cache(query: str, payload: dict) -> None:
    with contextlib.suppress(OSError, TypeError, ValueError):
        with open(_cache_path(query), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)


def _network_enum(group: str, name: str):
    enum = getattr(QNetworkRequest, group, None)
    return getattr(enum, name) if enum is not None else getattr(QNetworkRequest, name)


def _post(endpoint: str, query: str):
    """(payload, error_text, transient)"""
    url = QUrl(endpoint)
    body_query = QUrlQuery()
    body_query.addQueryItem("data", query)
    body = QByteArray(body_query.query(QUrl.ComponentFormattingOption.FullyEncoded).encode("ascii"))
    request = QNetworkRequest(url)
    if hasattr(request, "setTransferTimeout"):
        request.setTransferTimeout((TIMEOUT_S + 15) * 1000)
    request.setHeader(_network_enum("KnownHeaders", "ContentTypeHeader"), "application/x-www-form-urlencoded")
    request.setRawHeader(b"Accept", b"application/json")
    request.setRawHeader(b"User-Agent", _user_agent().encode("ascii", errors="replace"))
    client = QgsBlockingNetworkRequest()
    code = client.post(request, body, False, None)
    if enum_value(code) != enum_value(QgsBlockingNetworkRequest.NoError):
        return None, (client.errorMessage() or "network error").strip(), True
    reply = client.reply()
    try:
        status = int(reply.attribute(_network_enum("Attribute", "HttpStatusCodeAttribute")))
    except (TypeError, ValueError):
        status = 0
    if status and not 200 <= status < 300:
        return None, f"HTTP {status}", status == 429 or status >= 500
    content = bytes(reply.content())
    if len(content) > MAX_RESPONSE_BYTES:
        return None, "response too large; pick a smaller area", False
    try:
        payload = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        return None, f"not JSON ({exc})", False
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        return None, "unexpected response", False
    if payload.get("remark"):
        return None, f"incomplete response: {payload['remark']}", True
    return payload, "", False


def fetch(s: float, w: float, n: float, e: float, progress=None) -> dict:
    progress = progress or (lambda msg: None)
    query = _query(s, w, n, e)
    cached = _read_cache(query)
    if cached is not None:
        progress("Using the cached OSM response.")
        return cached
    failures = []
    for endpoint in ENDPOINTS:
        host = QUrl(endpoint).host()
        for attempt in range(2):
            progress(f"Querying {host} ..." if not attempt else f"Retrying {host} ...")
            if attempt:
                time.sleep(1.5)
            payload, error, transient = _post(endpoint, query)
            if payload is not None:
                _write_cache(query, payload)
                return payload
            failures.append(f"{host}: {error}")
            if not transient:
                break
    raise OsmError("Every Overpass server failed (" + "; ".join(failures[-3:]) + "). "
                   "Wait a minute and try again, or pick a smaller area.")


# ---------------------------------------------------------------- geometry
def _points(geometry) -> list:
    out = []
    for item in geometry or []:
        try:
            lon, lat = float(item["lon"]), float(item["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(lon) and math.isfinite(lat):
            point = QgsPointXY(lon, lat)
            if not out or (out[-1].x(), out[-1].y()) != (lon, lat):
                out.append(point)
    return out


def _ring_polygon(points: list):
    if len(points) < 3:
        return None
    if (points[0].x(), points[0].y()) != (points[-1].x(), points[-1].y()):
        points = points + [points[0]]
    if len(points) < 4:
        return None
    poly = QgsGeometry.fromPolygonXY([points])
    if not poly.isGeosValid():
        poly = poly.makeValid()
    return poly if poly and not poly.isEmpty() else None


def _stitch(paths: list) -> list:
    key = lambda p: (round(p.x(), 9), round(p.y(), 9))  # noqa: E731
    pending = [list(p) for p in paths if len(p) >= 2]
    rings = []
    while pending:
        chain = pending.pop(0)
        progress = True
        while key(chain[0]) != key(chain[-1]) and progress:
            progress = False
            for index, path in enumerate(pending):
                if key(chain[-1]) == key(path[0]):
                    chain = chain + path[1:]
                elif key(chain[-1]) == key(path[-1]):
                    chain = chain + list(reversed(path[:-1]))
                elif key(chain[0]) == key(path[-1]):
                    chain = path[:-1] + chain
                elif key(chain[0]) == key(path[0]):
                    chain = list(reversed(path[1:])) + chain
                else:
                    continue
                pending.pop(index)
                progress = True
                break
        if key(chain[0]) == key(chain[-1]) and len(chain) >= 4:
            rings.append(chain)
    return rings


def _relation_polygon(element):
    outers, inners = [], []
    for member in element.get("members") or []:
        if member.get("type") != "way":
            continue
        role = (member.get("role") or "").lower()
        (inners if role == "inner" else outers).append(_points(member.get("geometry")))
    polys = [p for p in (_ring_polygon(r) for r in _stitch(outers)) if p is not None]
    if not polys:
        return None
    shape = QgsGeometry.unaryUnion(polys)
    holes = [p for p in (_ring_polygon(r) for r in _stitch(inners)) if p is not None]
    if holes:
        shape = shape.difference(QgsGeometry.unaryUnion(holes))
    return shape if shape and not shape.isEmpty() else None


def _is_polygon(geom) -> bool:
    return enum_value(QgsWkbTypes.geometryType(geom.wkbType())) == 2


# ---------------------------------------------------------------- layers
def download_to_gpkg(extent: QgsRectangle, extent_crs: QgsCoordinateReferenceSystem, out_path: str,
                     progress=None) -> dict:
    """Download buildings and trees inside ``extent`` and write them to a
    GeoPackage in a metric CRS. Returns {"buildings": n, "trees": n, "crs": authid}."""
    wgs = QgsCoordinateReferenceSystem("EPSG:4326")
    bbox = QgsCoordinateTransform(extent_crs, wgs, QgsProject.instance()).transformBoundingBox(extent)
    centre = bbox.center()
    km_x = bbox.width() * 111.32 * math.cos(math.radians(centre.y()))
    km_y = bbox.height() * 110.57
    if km_x * km_y > MAX_AREA_KM2:
        raise OsmError(f"The area is {km_x * km_y:.1f} km²; OSM download is limited to {MAX_AREA_KM2:.0f} km². "
                       "Zoom in or pick a smaller extent.")
    payload = fetch(bbox.yMinimum(), bbox.xMinimum(), bbox.yMaximum(), bbox.xMaximum(), progress)
    epsg = geo.utm_epsg_for(centre.x(), centre.y())
    dest = QgsCoordinateReferenceSystem(f"EPSG:{epsg}")
    xform = QgsCoordinateTransform(wgs, dest, QgsProject.instance())
    clip = QgsGeometry.fromRect(bbox)

    buildings = QgsVectorLayer(
        f"MultiPolygon?crs=EPSG:{epsg}&field=osm_id:string(32)&field=building:string(40)"
        "&field=name:string(120)&field=height_m:double&field=levels:integer&field=height_src:string(10)",
        "OSM buildings", "memory")
    trees = QgsVectorLayer(f"Point?crs=EPSG:{epsg}&field=osm_id:string(32)&field=height_m:double",
                           "OSM trees", "memory")
    b_feats, t_feats = [], []
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        etype = element.get("type")
        if etype == "node" and tags.get("natural") == "tree":
            try:
                point = QgsGeometry.fromPointXY(QgsPointXY(float(element["lon"]), float(element["lat"])))
            except (KeyError, TypeError, ValueError):
                continue
            point.transform(xform)
            feat = QgsFeature(trees.fields())
            feat.setGeometry(point)
            feat.setAttributes([f"n{element.get('id')}", osm_tags.tree_height(tags)])
            t_feats.append(feat)
            continue
        if "building" not in tags or tags.get("building") in ("no", "construction"):
            continue
        geom = _relation_polygon(element) if etype == "relation" else _ring_polygon(_points(element.get("geometry")))
        if geom is None or not _is_polygon(geom):
            continue
        centre_pt = geom.pointOnSurface()
        if centre_pt.isEmpty() or not clip.contains(centre_pt):
            continue
        geom.transform(xform)
        height, levels, source = osm_tags.building_height(tags)
        feat = QgsFeature(buildings.fields())
        feat.setGeometry(geom)
        feat.setAttributes([f"{etype[0]}{element.get('id')}", str(tags.get("building"))[:40],
                            str(tags.get("name") or "")[:120], height, levels, source])
        b_feats.append(feat)
    buildings.dataProvider().addFeatures(b_feats)
    trees.dataProvider().addFeatures(t_feats)
    if not b_feats and not t_feats:
        raise OsmError("OSM has no buildings or trees in this area.")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    first = True
    for layer, name in ((buildings, "osm_buildings"), (trees, "osm_trees")):
        if layer.featureCount() == 0:
            continue
        options = QgsVectorFileWriter.SaveVectorOptions()
        options.driverName = "GPKG"
        options.layerName = name
        options.actionOnExistingFile = (QgsVectorFileWriter.CreateOrOverwriteFile if first
                                        else QgsVectorFileWriter.CreateOrOverwriteLayer)
        result = QgsVectorFileWriter.writeAsVectorFormatV3(layer, out_path, QgsProject.instance().transformContext(),
                                                           options)
        if result[0] != QgsVectorFileWriter.NoError:
            raise OsmError(f"Cannot write {out_path}: {result[1]}")
        first = False
    return {"buildings": len(b_feats), "trees": len(t_feats), "crs": dest.authid()}
