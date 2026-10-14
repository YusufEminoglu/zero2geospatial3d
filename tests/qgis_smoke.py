"""QGIS acceptance suite for zero2geospatial3d.

Runs on a real QGIS (3 LTR and 4):

    python-qgis-ltr.bat -m zero2geospatial3d.tests.qgis_smoke
    python-qgis.bat     -m zero2geospatial3d.tests.qgis_smoke

Checks values, not just "it ran": exported heights, colours and local
coordinates against the source layers, the DEM grid against a known plane,
the per-building climate mean against the raster, the GeoTIFF georeference
written back, and the join of result fields onto the right features.
"""
from __future__ import annotations

import base64
import configparser
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(PLUGIN_DIR.parent) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR.parent))

from qgis.PyQt.QtCore import QObject, pyqtSignal  # noqa: E402
from qgis.PyQt.QtGui import QColor  # noqa: E402
from qgis.PyQt.QtWidgets import QMainWindow, QToolBar  # noqa: E402
from qgis.core import (  # noqa: E402
    QgsApplication,
    QgsCategorizedSymbolRenderer,
    QgsCoordinateReferenceSystem,
    QgsFeature,
    QgsFillSymbol,
    QgsGeometry,
    QgsPointXY,
    QgsProject,
    QgsRasterLayer,
    QgsRectangle,
    QgsRendererCategory,
    QgsSingleBandPseudoColorRenderer,
    QgsVectorLayer,
)
from qgis.gui import QgsMapCanvas  # noqa: E402

PACKAGE = "zero2geospatial3d"
RESULTS = []


def check(name, condition, detail=""):
    tag = "PASS" if condition else "FAIL"
    print(f"  [{tag}] {name}" + (f" - {detail}" if detail else ""))
    RESULTS.append(bool(condition))
    return bool(condition)


class _MessageBar:
    def pushMessage(self, *args, **kwargs):
        return None

    pushInfo = pushWarning = pushCritical = pushSuccess = pushMessage


class _StatusBar:
    def showMessage(self, *args):
        return None


class _Iface(QObject):
    currentLayerChanged = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        self._window = QMainWindow()
        self._canvas = QgsMapCanvas(self._window)
        self._window.setCentralWidget(self._canvas)
        self.docks = []

    def mainWindow(self):
        return self._window

    def mapCanvas(self):
        return self._canvas

    def messageBar(self):
        return _MessageBar()

    def statusBarIface(self):
        return _StatusBar()

    def addToolBar(self, toolbar):
        self._window.addToolBar(toolbar)
        return toolbar

    def addDockWidget(self, area, dock):
        self.docks.append(dock)
        self._window.addDockWidget(area, dock)

    def removeDockWidget(self, dock):
        if dock in self.docks:
            self.docks.remove(dock)
        self._window.removeDockWidget(dock)


# ---------------------------------------------------------------- fixtures
CRS = "EPSG:32635"
X0, Y0 = 500000.0, 4250000.0   # DEM upper-left corner
CELL = 5.0
COLS, ROWS = 120, 100


def dem_z(x, y):
    """Plane used for the DEM: rises 0.1 m per m to the east."""
    return 100.0 + 0.1 * (x - X0)


def make_rasters(folder):
    from osgeo import gdal, osr

    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32635)
    paths = {}
    for name, fn in (("dem", dem_z), ("lst", lambda x, y: 30.0 + 0.01 * (Y0 - y))):
        path = os.path.join(folder, f"{name}.tif")
        ds = gdal.GetDriverByName("GTiff").Create(path, COLS, ROWS, 1, gdal.GDT_Float32)
        ds.SetGeoTransform((X0, CELL, 0, Y0, 0, -CELL))
        ds.SetProjection(srs.ExportToWkt())
        rows = []
        for r in range(ROWS):
            y = Y0 - (r + 0.5) * CELL
            rows.append([fn(X0 + (c + 0.5) * CELL, y) for c in range(COLS)])
        import numpy as np

        ds.GetRasterBand(1).WriteArray(np.array(rows, dtype="float32"))
        ds = None
        paths[name] = path
    return paths


def square(cx, cy, s):
    return QgsGeometry.fromPolygonXY([[QgsPointXY(cx - s, cy - s), QgsPointXY(cx + s, cy - s),
                                       QgsPointXY(cx + s, cy + s), QgsPointXY(cx - s, cy + s)]])


def make_vectors():
    b = QgsVectorLayer(f"Polygon?crs={CRS}&field=floors:integer&field=use:string(20)", "Test buildings", "memory")
    feats = []
    specs = [(X0 + 100, Y0 - 100, 3, "home"), (X0 + 300, Y0 - 250, 10, "office"), (X0 + 450, Y0 - 400, 5, "home"),
             (X0 - 500, Y0 + 500, 4, "home")]  # last one lies outside the DEM: must be left out
    for cx, cy, floors, use in specs:
        f = QgsFeature(b.fields())
        f.setGeometry(square(cx, cy, 10))
        f.setAttributes([floors, use])
        feats.append(f)
    b.dataProvider().addFeatures(feats)
    cats = []
    for value, color in (("home", "#ff0000"), ("office", "#0000ff")):
        sym = QgsFillSymbol.createSimple({"color": color})
        cats.append(QgsRendererCategory(value, sym, value))
    b.setRenderer(QgsCategorizedSymbolRenderer("use", cats))
    t = QgsVectorLayer(f"Point?crs={CRS}&field=h:double", "Trees", "memory")
    tf = QgsFeature(t.fields())
    tf.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(X0 + 200, Y0 - 200)))
    tf.setAttributes([12.0])
    t.dataProvider().addFeatures([tf])
    w = QgsVectorLayer(f"LineString?crs=EPSG:4326&field=h:double", "Walls", "memory")  # geographic on purpose
    wf = QgsFeature(w.fields())
    from qgis.core import QgsCoordinateTransform

    xf = QgsCoordinateTransform(QgsCoordinateReferenceSystem(CRS), QgsCoordinateReferenceSystem("EPSG:4326"), QgsProject.instance())
    p1 = xf.transform(QgsPointXY(X0 + 50, Y0 - 50))
    p2 = xf.transform(QgsPointXY(X0 + 150, Y0 - 50))
    wf.setGeometry(QgsGeometry.fromPolylineXY([p1, p2]))
    wf.setAttributes([2.5])
    w.dataProvider().addFeatures([wf])
    return b, t, w


# ---------------------------------------------------------------- tests
def test_metadata():
    raw = (PLUGIN_DIR / "metadata.txt").read_text(encoding="utf-8")
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(raw)
    meta = {k.lower(): v for k, v in parser["general"].items()}
    missing = [k for k in ("name", "version", "qgisminimumversion", "description", "author", "email") if not meta.get(k)]
    check("metadata complete, semver, no literal %", not missing and re.match(r"^\d+\.\d+\.\d+$", meta["version"]) and "%" not in raw,
          f"missing={missing} version={meta.get('version')}")
    check("icon exists", (PLUGIN_DIR / meta.get("icon", "")).is_file())
    check("experimental is False", meta.get("experimental", "").strip() == "False")


def test_lifecycle(iface):
    module = __import__(PACKAGE)
    plugin = module.classFactory(iface)
    before = {tb.objectName() for tb in iface.mainWindow().findChildren(QToolBar)}
    plugin.initGui()
    plugin.toggle_dock()
    app = QgsApplication.instance()
    app.processEvents()
    dock_ok = plugin.dock is not None and len(iface.docks) == 1
    plugin.unload()
    app.sendPostedEvents()
    app.processEvents()
    after = {tb.objectName() for tb in iface.mainWindow().findChildren(QToolBar)}
    check("initGui, open panel, unload: nothing left behind", dock_ok and not (after - before) and not iface.docks,
          f"dock={dock_ok} toolbars={sorted(after - before)} docks={len(iface.docks)}")


def test_guesses(b, t, w):
    from zero2geospatial3d.ui.dock import guess_height_expression, guess_role

    role, checked = guess_role(b)
    check("role guess: polygon layer named 'buildings' is extruded and ticked", role == "buildings" and checked, f"{role} {checked}")
    check("height guess: floors field becomes floors x 3", guess_height_expression(b, "buildings") == '"floors" * 3')
    check("height guess: a numeric 'h' field is used for trees",
          guess_height_expression(t, "trees") == '"h"', guess_height_expression(t, "trees"))


def test_export(folder, iface):
    from zero2geospatial3d.core import scene_export as sx

    paths = make_rasters(folder)
    dem = QgsRasterLayer(paths["dem"], "DEM")
    lst = QgsRasterLayer(paths["lst"], "LST")
    b, t, w = make_vectors()
    for layer in (dem, lst, b, t, w):
        QgsProject.instance().addMapLayer(layer)
    test_guesses(b, t, w)
    out = os.path.join(folder, "scene")
    spec = sx.ExportSpec(out_dir=out, extent=dem.extent(), extent_crs=dem.crs(), dem=dem, cell_size=None,
                         layers=[sx.LayerSpec(b, "buildings", '"floors" * 3'), sx.LayerSpec(t, "trees", '"h"'),
                                 sx.LayerSpec(w, "walls", '"h"')],
                         climate_rasters=[lst], epw_path="", title="Test")
    result = sx.SceneExporter(spec).run()
    m = json.loads(Path(out, "scene.json").read_text(encoding="utf-8"))
    check("export CRS is the DEM's", m["crs"]["authid"] == CRS, m["crs"]["authid"])
    g = m["grid"]
    check("grid matches the DEM extent at its own resolution", g["cols"] == COLS and g["rows"] == ROWS and abs(g["cell"] - CELL) < 1e-9,
          f"{g['cols']}x{g['rows']} @ {g['cell']}")
    ox, oy = m["origin"]
    check("origin is the extent centre", abs(ox - (X0 + COLS * CELL / 2)) < 1e-6 and abs(oy - (Y0 - ROWS * CELL / 2)) < 1e-6, f"{ox}, {oy}")
    raw = Path(out, "terrain.bin").read_bytes()
    values = struct.unpack(f"<{COLS * ROWS}f", raw)
    r, c = 37, 81
    x = ox + g["minX"] + c * g["cell"]
    expect = dem_z(x, 0)
    check("terrain.bin reproduces the DEM plane", abs(values[r * COLS + c] - expect) < 1e-3, f"{values[r * COLS + c]:.3f} vs {expect:.3f}")
    layers = {e["name"]: e for e in m["layers"]}
    check("all three layers exported with their roles", set(layers) == {"Test buildings", "Trees", "Walls"} and
          layers["Walls"]["role"] == "walls", str(sorted(layers)))
    bdata = json.loads(Path(out, layers["Test buildings"]["file"]).read_text(encoding="utf-8"))
    feats = bdata["features"]
    check("building outside the scene is left out", len(feats) == 3, f"{len(feats)} features")
    by_floors = {f["properties"]["floors"]: f for f in feats}
    check("heights come from the expression (floors x 3)", all(abs(f["properties"]["_h"] - 3 * k) < 1e-9 for k, f in by_floors.items()))
    check("colours come from the categorized QGIS style",
          by_floors[10]["properties"]["_c"] == "#0000ff" and by_floors[3]["properties"]["_c"] == "#ff0000",
          f"{by_floors[10]['properties']['_c']} {by_floors[3]['properties']['_c']}")
    ring = by_floors[10]["geometry"]["coordinates"][0][0]
    xs = [p[0] for p in ring]
    cx = (min(xs) + max(xs)) / 2 + ox
    check("coordinates are local metres (CRS minus origin)", abs(cx - (X0 + 300)) < 0.02, f"{cx}")
    ids = json.loads(Path(out, "L1.ids.json").read_text())
    check("ids file maps viewer ids to source fids", len(ids) == 3 and all(isinstance(i, int) for i in ids), str(ids))
    clim = by_floors[10]["properties"].get("clim_lst")
    expect_lst = 30.0 + 0.01 * 250
    check("climate raster averaged per building footprint", clim is not None and abs(clim - expect_lst) < 0.06, f"{clim} vs {expect_lst}")
    wdata = json.loads(Path(out, layers["Walls"]["file"]).read_text(encoding="utf-8"))
    wl = wdata["features"][0]["geometry"]["coordinates"][0]
    length = math.hypot(wl[-1][0] - wl[0][0], wl[-1][1] - wl[0][1])
    check("geographic layer reprojected into the scene CRS", abs(length - 100) < 0.5, f"wall length {length:.2f} m")
    check("no export warnings beyond the expected", all("truncated" not in w2 for w2 in result.warnings), str(result.warnings))
    return out, m, b


def test_results(scene_dir, manifest, b):
    import numpy as np

    from zero2geospatial3d.core.results import ResultWriter, select_in_qgis, viewer_ids_for_selection

    writer = ResultWriter(scene_dir)
    g = manifest["grid"]
    cols, rows = 40, 30
    values = np.arange(cols * rows, dtype="<f4")
    values[5] = np.nan
    grid = {"cols": cols, "rows": rows, "cell": 2.0, "minX": g["minX"], "maxY": g["maxY"]}
    msg = writer.handle({"type": "grid", "name": "Sun hours test", "key": "sun_test", "unit": "h", "grid": grid,
                         "data": base64.b64encode(values.tobytes()).decode(), "style": {"min": 0, "max": 1200, "ramp": "magma"}})
    tif = Path(scene_dir, "results", "sun_test.tif")
    check("grid result written as GeoTIFF", tif.is_file(), msg)
    layer = QgsRasterLayer(str(tif), "t")
    ox, oy = manifest["origin"]
    ext = layer.extent()
    check("GeoTIFF georeferenced at the grid's north-west corner",
          abs(ext.xMinimum() - (ox + g["minX"] - 1.0)) < 1e-6 and abs(ext.yMaximum() - (oy + g["maxY"] + 1.0)) < 1e-6,
          f"{ext.xMinimum():.2f},{ext.yMaximum():.2f}")
    from osgeo import gdal

    arr = gdal.Open(str(tif)).ReadAsArray()
    check("GeoTIFF values keep row order and NaN no-data", arr[0, 7] == 7 and math.isnan(arr[0, 5]) and arr[29, 39] == cols * rows - 1)
    added = [lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "Sun hours test"]
    check("raster added with a pseudocolour renderer", added and isinstance(added[0].renderer(), QgsSingleBandPseudoColorRenderer))
    # Per-feature fields: viewer id 2 -> second exported feature.
    ids = json.loads(Path(scene_dir, "L1.ids.json").read_text())
    writer.handle({"type": "features", "layer": "L1", "fields": {"sun_h_roof": {"values": {"1": 1.5, "2": 2.5, "3": 3.5}}}})
    writer.handle({"type": "features", "layer": "L1", "fields": {"pv_kwh_yr": {"values": {"2": 1234.0}}}})
    res = [lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "Test buildings (3D results)"]
    ok = bool(res)
    detail = ""
    if ok:
        rl = res[0]
        by_src = {}
        src_feats = {f.id(): f for f in b.getFeatures()}
        for f in rl.getFeatures():
            by_src[f["g3d_id"]] = (f["floors"], f["sun_h_roof"], f["pv_kwh_yr"])
        expect_floors = src_feats[ids[1]]["floors"]
        pv1 = by_src[1][2]
        pv1_empty = pv1 is None or str(pv1) == "NULL" or (isinstance(pv1, float) and math.isnan(pv1))
        ok = (by_src[2][0] == expect_floors and abs(by_src[2][1] - 2.5) < 1e-9 and abs(by_src[1][1] - 1.5) < 1e-9
              and abs(by_src[2][2] - 1234) < 1e-9 and pv1_empty)
        detail = str(by_src)
    check("feature results joined onto the right features in a GeoPackage", ok, detail)
    msg = select_in_qgis(manifest, scene_dir, {"layer": "L1", "ids": [2, 3]})
    check("viewer pick selects the source features", sorted(b.selectedFeatureIds()) == sorted(ids[1:3]), msg)
    back = viewer_ids_for_selection(manifest, scene_dir)
    check("QGIS selection maps back to viewer ids", sorted(back.get("L1", [])) == [2, 3], str(back))


def test_server(scene_dir):
    from zero2geospatial3d.core.server import ViewerServer

    server = ViewerServer(str(PLUGIN_DIR / "web"), version="test")
    server.set_scene_dir(scene_dir)
    url = server.start()
    base = server.base_url
    try:
        ping = json.loads(urllib.request.urlopen(base + "api/ping", timeout=5).read())  # noqa: S310 - local test server
        scene = json.loads(urllib.request.urlopen(base + "scene/scene.json", timeout=5).read())  # noqa: S310
        req = urllib.request.Request(base + "api/result", data=json.dumps({"type": "grid", "x": 1}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).read()  # noqa: S310
        popped = server.bridge.pop_results()
        blocked = False
        try:
            urllib.request.urlopen(base + "scene/..%2F..%2Fmetadata.txt", timeout=5).read()  # noqa: S310
        except Exception:  # noqa: BLE001 - any refusal is the expected outcome
            blocked = True
        check("server: ping, scene files, result queue", ping.get("ok") and scene.get("format") and popped == [{"type": "grid", "x": 1}],
              url)
        check("server: no path traversal out of the scene folder", blocked)
    finally:
        server.stop()


def test_dock_flow(folder, iface):
    """Drive the panel like a user: rows, DEM, Open in 3D, then a result posted to the server."""
    from qgis.PyQt.QtGui import QDesktopServices

    from zero2geospatial3d.ui import dock as dock_mod

    opened = []
    original = QDesktopServices.openUrl
    dock_mod.QDesktopServices.openUrl = staticmethod(lambda url: opened.append(url.toString()) or True)
    panel = None
    try:
        panel = dock_mod.Geo3DDock(iface, str(PLUGIN_DIR))
        panel.refresh_layers()
        rows = {r.layer.name(): r for r in panel.rows}
        dem = next(lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "DEM")
        panel.dem.setLayer(dem)
        for name, row in rows.items():
            row.check.setChecked(name == "Test buildings")
        rows["Test buildings"].scenario.setCurrentIndex(rows["Test buildings"].scenario.findData("A"))
        check("panel row keeps scenario and role while the panel is hidden",
              rows["Test buildings"].spec().scenario == "A" and not panel.isVisible())
        panel.folder.setFilePath(os.path.join(folder, "dock_scene"))
        panel.open_in_3d()
        scene = Path(folder, "dock_scene", "scene.json")
        ok_scene = scene.is_file() and json.loads(scene.read_text(encoding="utf-8"))["layers"][0]["heightExpr"] == '"floors" * 3'
        check("panel: Open in 3D writes the scene with the guessed height expression", ok_scene)
        check("panel: the viewer URL is opened on the local server", opened and opened[0].startswith("http://127.0.0.1:"), str(opened))
        values = (b"\x00\x00\x80\x3f" * 4)  # four float32 ones
        body = json.dumps({"type": "grid", "name": "Posted grid", "key": "posted", "unit": "",
                           "grid": {"cols": 2, "rows": 2, "cell": 5, "minX": 0, "maxY": 0},
                           "data": base64.b64encode(values).decode()}).encode()
        req = urllib.request.Request(panel.server.base_url + "api/result", data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).read()  # noqa: S310 - local test server
        panel._poll_viewer()
        got = [lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "Posted grid"]
        check("panel: a result posted by the viewer becomes a QGIS layer", bool(got) and got[0].isValid())
    finally:
        dock_mod.QDesktopServices.openUrl = original
        if panel is not None:
            panel.shutdown()
            panel.deleteLater()


def test_building_parts(folder):
    """OSM building:part replaces its outline; the exporter writes _b and _grp."""
    from qgis.core import QgsCoordinateTransform

    from zero2geospatial3d.core import osm
    from zero2geospatial3d.core import scene_export as sx

    def ring(lon0, lat0, d):
        pts = [(lon0, lat0), (lon0 + d, lat0), (lon0 + d, lat0 + d), (lon0, lat0 + d), (lon0, lat0)]
        return [{"lon": x, "lat": y} for x, y in pts]

    payload = {"elements": [
        {"type": "way", "id": 1, "tags": {"building": "apartments", "name": "Complex", "building:levels": "58"},
         "geometry": ring(27.000, 38.000, 0.001)},
        {"type": "way", "id": 2, "tags": {"building:part": "yes", "height": "12"}, "geometry": ring(27.0001, 38.0001, 0.0008)},
        {"type": "way", "id": 3, "tags": {"building:part": "yes", "building:levels": "40", "building:min_level": "4"},
         "geometry": ring(27.0003, 38.0003, 0.0002)},
        {"type": "way", "id": 4, "tags": {"building": "house"}, "geometry": ring(27.003, 38.003, 0.0002)},
        {"type": "node", "id": 9, "lon": 27.002, "lat": 38.002, "tags": {"natural": "tree", "height": "11"}},
    ]}
    wgs = QgsCoordinateReferenceSystem("EPSG:4326")
    xform = QgsCoordinateTransform(wgs, QgsCoordinateReferenceSystem("EPSG:32635"), QgsProject.instance())
    clip = QgsGeometry.fromRect(QgsRectangle(26.99, 37.99, 27.01, 38.01))
    b, t = osm.payload_to_layers(payload, clip, xform, 32635)
    rows = {f["osm_id"]: f for f in b.getFeatures()}
    check("OSM parts replace their outline", "w1" not in rows and {"w2", "w3", "w4"} <= set(rows), str(sorted(rows)))
    tower, podium, house = rows.get("w3"), rows.get("w2"), rows.get("w4")
    ok = (tower is not None and tower["height_m"] == 120 and tower["min_height_m"] == 12 and tower["part"] == 1
          and tower["bldg_group"] == "w1" and tower["name"] == "Complex" and podium["bldg_group"] == "w1"
          and podium["min_height_m"] == 0 and house["part"] == 0 and house["bldg_group"] == "w4")
    check("tower part: top 120 m, bottom 12 m, grouped with the podium, name inherited", ok,
          f"tower={tower and (tower['height_m'], tower['min_height_m'], tower['bldg_group'], tower['name'])}")
    check("trees parsed", t.featureCount() == 1 and list(t.getFeatures())[0]["height_m"] == 11)
    QgsProject.instance().addMapLayer(b)
    out = os.path.join(folder, "parts_scene")
    spec = sx.ExportSpec(out_dir=out, extent=b.extent(), extent_crs=b.crs(),
                         layers=[sx.LayerSpec(b, "buildings", '"height_m"', base_expr='"min_height_m"')])
    sx.SceneExporter(spec).run()
    feats = json.loads(Path(out, "L1.geojson").read_text(encoding="utf-8"))["features"]
    by = {f["properties"]["osm_id"]: f["properties"] for f in feats}
    check("exporter writes the bottom (_b) and the building group (_grp)",
          by["w3"].get("_b") == 12 and by["w3"].get("_grp") == "w1" and "_b" not in by["w2"] and by["w4"].get("_grp") == "w4",
          str({k: (v.get("_b"), v.get("_grp")) for k, v in by.items()}))


def test_detail_limit(folder):
    """Large DEMs keep their resolution up to the chosen limit; the viewer tiles them."""
    import numpy as np
    from osgeo import gdal, osr

    from zero2geospatial3d.core import scene_export as sx

    path = os.path.join(folder, "big_dem.tif")
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32635)
    ds = gdal.GetDriverByName("GTiff").Create(path, 2400, 1800, 1, gdal.GDT_Float32)
    ds.SetGeoTransform((X0, 1.0, 0, Y0, 0, -1.0))
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).WriteArray(np.fromfunction(lambda r, c: 50 + 0.01 * c, (1800, 2400), dtype="float32"))
    ds = None
    dem = QgsRasterLayer(path, "big")
    out = {}
    for limit in (2048, 4096):
        spec = sx.ExportSpec(out_dir=os.path.join(folder, f"big_{limit}"), extent=dem.extent(), extent_crs=dem.crs(),
                             dem=dem, max_cells=limit)
        g = sx.SceneExporter(spec).run().manifest["grid"]
        out[limit] = (g["cols"], g["rows"], round(g["cell"], 4))
    check("detail limit: 2048 coarsens a 2400-column DEM, 4096 keeps its own 1 m cells",
          out[2048][0] == 2048 and out[2048][2] > 1 and out[4096] == (2400, 1800, 1.0), str(out))


def test_quick_3d(folder, iface):
    from zero2geospatial3d.ui import dock as dock_mod

    opened = []
    original = dock_mod.QDesktopServices.openUrl
    dock_mod.QDesktopServices.openUrl = staticmethod(lambda url: opened.append(url.toString()) or True)
    panel = None
    try:
        panel = dock_mod.Geo3DDock(iface, str(PLUGIN_DIR))
        dem = next(lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "DEM")
        panel.folder.setFilePath(os.path.join(folder, "q"))
        panel.quick_3d(dem)
        m = json.loads(Path(folder, "q", "quick", "scene.json").read_text(encoding="utf-8"))
        check("Quick 3D: DEM alone, opened in the viewer", m["terrain"] and not m["layers"] and opened, m["title"])
    finally:
        dock_mod.QDesktopServices.openUrl = original
        if panel is not None:
            panel.shutdown()
            panel.deleteLater()


def test_epw_and_osm(folder):
    from zero2geospatial3d.core import epw, osm_tags

    text = "LOCATION,Testville,TR,TUR,TMYx,172200,38.4,27.1,3.0,29.0\n" + "x\n" * 10
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "hi")
        z.writestr("Test.epw", text)
    target = os.path.join(folder, "w", "t.epw")
    epw.extract_epw(buf.getvalue(), target)
    head = epw.read_header(target)
    near = epw.nearest_stations(38.42, 27.14, 1)[0]
    check("EPW: archive extracted and LOCATION parsed", head["utc"] == 3.0 and abs(head["lat"] - 38.4) < 1e-9)
    check("EPW: bundled index finds the nearest station", near["distance_km"] < 20 and near["url"].startswith("https://climate.onebuilding.org/"),
          f"{near['station']} {near['distance_km']} km")
    check("OSM tags: height, levels and default", osm_tags.building_height({"building": "yes", "height": "12 m"})[0] == 12 and
          osm_tags.building_height({"building": "apartments", "building:levels": "5"})[:2] == (15.0, 5) and
          osm_tags.building_height({"building": "warehouse"})[2] == "default")


def main():
    app = QgsApplication.instance()
    owns = app is None
    profile = tempfile.TemporaryDirectory(prefix="g3d-smoke-")
    if owns:
        app = QgsApplication([], True, profile.name, "external")
        app.initQgis()
    folder = tempfile.mkdtemp(prefix="g3d-test-")
    iface = _Iface()
    print("=" * 60)
    print(" zero2geospatial3d - QGIS acceptance")
    print("=" * 60)
    try:
        test_metadata()
        test_lifecycle(iface)
        scene_dir, manifest, b = test_export(folder, iface)
        test_results(scene_dir, manifest, b)
        test_server(scene_dir)
        test_dock_flow(folder, iface)
        test_quick_3d(folder, iface)
        test_building_parts(folder)
        test_detail_limit(folder)
        test_epw_and_osm(folder)
    except Exception as exc:  # noqa: BLE001 - a crash is a failure with a trace
        import traceback

        traceback.print_exc()
        check("suite ran to the end", False, repr(exc))
    finally:
        QgsProject.instance().removeAllMapLayers()
        iface.mainWindow().close()
        shutil.rmtree(folder, ignore_errors=True)
    passed = sum(RESULTS)
    print("-" * 60)
    print(f"  {passed}/{len(RESULTS)} passed, {len(RESULTS) - passed} failed")
    if owns:
        app.exitQgis()
    return passed == len(RESULTS)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
