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
        self.menus = []

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

    def addPluginToMenu(self, name, action):
        self.menus.append((name, action))

    def removePluginMenu(self, name, action):
        if (name, action) in self.menus:
            self.menus.remove((name, action))


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
    from zero2geospatial3d import PLUGIN_VERSION

    check("PLUGIN_VERSION matches metadata.txt", PLUGIN_VERSION == meta.get("version"),
          f"{PLUGIN_VERSION} vs {meta.get('version')}")


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
    check("initGui, open panel, unload: nothing left behind", dock_ok and not (after - before) and not iface.docks and not iface.menus,
          f"dock={dock_ok} toolbars={sorted(after - before)} docks={len(iface.docks)} menus={len(iface.menus)}")


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
    # QGIS 3D: the results copy is extruded and coloured like its 2D classes.
    ok3d, detail3d = False, ""
    if res:
        from qgis.PyQt import sip
        from qgis._3d import QgsPolygon3DSymbol, QgsRuleBased3DRenderer

        r3 = res[0].renderer3D()
        renderer2 = res[0].renderer()
        if r3 is not None and r3.type() == "rulebased":
            # The bindings hand back base classes; cast to reach rules and materials.
            r3 = sip.cast(r3, QgsRuleBased3DRenderer)
            rules = r3.rootRule().children()
            first = sip.cast(rules[0].symbol(), QgsPolygon3DSymbol)
            from qgis.core import QgsAbstract3DSymbol

            expr = first.dataDefinedProperties().property(QgsAbstract3DSymbol.Property.PropertyExtrusionHeight).expressionString()
            ranges = list(renderer2.ranges()) if hasattr(renderer2, "ranges") else []
            colour_ok = bool(ranges) and first.materialSettings().diffuse().name() == ranges[0].symbol().color().name()
            ok3d = (len(rules) == len(ranges) + 1 and colour_ok and expr == '"floors" * 3'
                    and int(getattr(first.altitudeClamping(), "value", first.altitudeClamping())) ==
                    int(getattr(__import__("qgis.core", fromlist=["Qgis"]).Qgis.AltitudeClamping.Terrain, "value", 2)))
            detail3d = f"rules={len(rules)} classes={len(ranges)} expr={expr} colour_ok={colour_ok}"
    check("results copy gets a QGIS 3D style: extruded, clamped to terrain, coloured per class", ok3d, detail3d)
    test_result_styles(writer, grid, values, res[0] if res else None)
    msg = select_in_qgis(manifest, scene_dir, {"layer": "L1", "ids": [2, 3]})
    check("viewer pick selects the source features", sorted(b.selectedFeatureIds()) == sorted(ids[1:3]), msg)
    back = viewer_ids_for_selection(manifest, scene_dir)
    check("QGIS selection maps back to viewer ids", sorted(back.get("L1", [])) == [2, 3], str(back))


def test_result_styles(writer, grid, values, results_layer):
    """The viewer's own colours reach QGIS: exact ramps, class palettes and
    the planning check's pass / fail classes in 2D and in the 3D view."""
    import numpy as np
    from qgis.core import QgsPalettedRasterRenderer

    data = base64.b64encode(values.tobytes()).decode()
    stops = ["#fcfdbf", "#fe9f6d", "#de4968", "#8c2981", "#3b0f70", "#000004"]  # magma reversed
    writer.handle({"type": "grid", "name": "Ramp test", "key": "ramp_test", "grid": grid, "data": data,
                   "style": {"min": 0, "max": 100, "ramp": "magma-r", "stops": stops}})
    lyr = [x for x in QgsProject.instance().mapLayers().values() if x.name() == "Ramp test"][0]
    items = lyr.renderer().shader().rasterShaderFunction().colorRampItemList()
    check("raster ramp uses the viewer's stops, reversed ramps included",
          items[0].color.name() == stops[0] and items[-1].color.name() == stops[-1],
          f"{items[0].color.name()} .. {items[-1].color.name()}")
    classes = np.zeros(values.shape, dtype="<f4")
    classes[::2] = 1
    writer.handle({"type": "grid", "name": "Class test", "key": "class_test", "grid": grid,
                   "data": base64.b64encode(classes.tobytes()).decode(),
                   "style": {"min": 0, "max": 1, "categories": [{"value": 0, "color": "#3b4a6b", "label": "Hidden"},
                                                                {"value": 1, "color": "#f6c945", "label": "Visible"}]}})
    lyr = [x for x in QgsProject.instance().mapLayers().values() if x.name() == "Class test"][0]
    ren = lyr.renderer()
    ok = isinstance(ren, QgsPalettedRasterRenderer) and [c.label for c in ren.classes()] == ["Hidden", "Visible"]         and ren.classes()[1].color.name() == "#f6c945"
    check("class rasters get a palette with the legend labels", ok, type(ren).__name__)
    if results_layer is None:
        check("planning-check classes styled in QGIS", False, "no results layer")
        return
    green, amber, red, grey = "#2e9e5c", "#f0b529", "#d64545", "#c9c9c9"
    writer.handle({"type": "features", "layer": "L1",
                   "fields": {"check_failed": {"values": {"1": 0, "2": 1}}, "check_heat": {"values": {"1": 1, "2": 0}}},
                   "style": {"field": "check_failed",
                             "categories": [{"value": 0, "color": green, "label": "Passes every check"},
                                            {"value": 1, "color": amber, "label": "Fails one"},
                                            {"value": 2, "color": red, "label": "Fails 2"}],
                             "other": {"color": grey, "label": "Not checked"}}})
    ren = results_layer.renderer()
    ok = isinstance(ren, QgsCategorizedSymbolRenderer) and ren.classAttribute() == "check_failed"
    colours = {}
    if ok:
        from qgis.core import QgsRenderContext

        ctx = QgsRenderContext()
        ren.startRender(ctx, results_layer.fields())
        for f in results_layer.getFeatures():
            sym = ren.symbolForFeature(f, ctx)
            colours[f["g3d_id"]] = sym.color().name() if sym else None
        ren.stopRender(ctx)
    ok = ok and colours.get(1) == green and colours.get(2) == amber and colours.get(3) == grey
    check("planning check styled by check_failed: pass, fail, not checked", ok, str(colours))
    from qgis.PyQt import sip
    from qgis._3d import QgsPolygon3DSymbol, QgsRuleBased3DRenderer

    r3 = results_layer.renderer3D()
    ok3, detail = False, ""
    if r3 is not None and r3.type() == "rulebased":
        rules = sip.cast(r3, QgsRuleBased3DRenderer).rootRule().children()
        diff = [sip.cast(r.symbol(), QgsPolygon3DSymbol).materialSettings().diffuse().name() for r in rules]
        labels = [r.description() for r in rules]
        ok3 = diff[:3] == [green, amber, red] and diff[-1] == grey and labels[-1] == "Not checked"
        detail = f"{list(zip(labels, diff))}"
    check("QGIS 3D view: the same classes, buildings not checked in grey", ok3, detail)


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
        # Scene files share one URL across exports: a conditional request must
        # still get the file (200), never "not modified" from another scene.
        req = urllib.request.Request(base + "scene/scene.json", headers={"If-Modified-Since": "Fri, 01 Jan 2100 00:00:00 GMT"})
        resp = urllib.request.urlopen(req, timeout=5)  # noqa: S310
        check("server: scene files are never answered 304 and never cached",
              resp.status == 200 and "no-store" in (resp.headers.get("Cache-Control") or ""), resp.headers.get("Cache-Control"))
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
        panel.setup_qgis_3d()
        terrain = QgsProject.instance().elevationProperties().terrainProvider()
        blayer = rows["Test buildings"].layer
        check("panel: QGIS 3D view uses the DEM as terrain and extrudes the buildings",
              terrain is not None and terrain.type() == "raster" and terrain.layer() is dem
              and blayer.renderer3D() is not None, f"terrain={terrain.type() if terrain else None}")
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
        # A primary road running out of the area, a footway and a motorway tunnel: one traffic source.
        {"type": "way", "id": 20, "tags": {"highway": "primary", "name": "Main"},
         "geometry": [{"lon": 27.000, "lat": 38.005}, {"lon": 27.050, "lat": 38.005}]},
        {"type": "way", "id": 21, "tags": {"highway": "footway"},
         "geometry": [{"lon": 27.000, "lat": 38.006}, {"lon": 27.005, "lat": 38.006}]},
        {"type": "way", "id": 22, "tags": {"highway": "motorway", "tunnel": "yes"},
         "geometry": [{"lon": 27.000, "lat": 38.007}, {"lon": 27.005, "lat": 38.007}]},
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
    roads = osm.payload_to_roads(payload, clip, xform, 32635)
    road = next(roads.getFeatures(), None)
    check("OSM roads: one traffic source, clipped to the area, weighted by class",
          roads.featureCount() == 1 and road["traffic_weight"] == 3.0 and road["highway"] == "primary"
          and road.geometry().length() < 1000, f"{roads.featureCount()} roads")
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
    # A 30 km DEM: no longer refused (the old limit was 20 km), only a warning.
    path = os.path.join(folder, "wide_dem.tif")
    ds = gdal.GetDriverByName("GTiff").Create(path, 300, 250, 1, gdal.GDT_Float32)
    ds.SetGeoTransform((X0, 100.0, 0, Y0, 0, -100.0))
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).WriteArray(np.full((250, 300), 80, dtype="float32"))
    ds = None
    wide = QgsRasterLayer(path, "wide")
    res = sx.SceneExporter(sx.ExportSpec(out_dir=os.path.join(folder, "wide"), extent=wide.extent(),
                                         extent_crs=wide.crs(), dem=wide)).run()
    check("a 30 km scene exports with a large-scene warning", res.manifest["grid"]["cols"] == 300 and
          any("Large scene" in w for w in res.warnings), str(res.warnings))


def test_clipped_dem(folder):
    """A DEM clipped to a concave polygon: the box around it is no data
    (-9999). Those cells must reach the viewer as a mask, never as ground,
    whether or not the file declares -9999 as its no-data value."""
    import numpy as np
    from osgeo import gdal, osr

    from zero2geospatial3d.core import scene_export as sx

    n, cell = 120, 5.0
    rr, cc = np.mgrid[0:n, 0:n]
    # A "U": two legs and a base; the notch between the legs is outside.
    inside = ((cc < 40) | (cc >= 80) | (rr >= 85)) & (cc >= 5) & (cc < n - 5) & (rr >= 5) & (rr < n - 5)
    z = np.where(inside, 100 + 0.2 * cc, -9999).astype(np.float32)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32635)
    seen = {}
    for declared in (True, False):
        path = os.path.join(folder, f"clipped_{declared}.tif")
        ds = gdal.GetDriverByName("GTiff").Create(path, n, n, 1, gdal.GDT_Float32)
        ds.SetGeoTransform((X0, cell, 0, Y0, 0, -cell))
        ds.SetProjection(srs.ExportToWkt())
        band = ds.GetRasterBand(1)
        band.WriteArray(z)
        if declared:
            band.SetNoDataValue(-9999)
        ds = None
        dem = QgsRasterLayer(path, f"clipped {declared}")
        out = os.path.join(folder, f"clipped_scene_{declared}")
        res = sx.SceneExporter(sx.ExportSpec(out_dir=out, extent=dem.extent(), extent_crs=dem.crs(), dem=dem)).run()
        t, g = res.manifest["terrain"], res.manifest["grid"]
        mask_path = os.path.join(out, t.get("mask") or "-")
        mask = np.fromfile(mask_path, dtype=np.uint8).reshape(g["rows"], g["cols"]) if os.path.isfile(mask_path) else None
        heights = np.fromfile(os.path.join(out, t["file"]), dtype="<f4")
        seen[declared] = (mask is not None and int((mask.astype(bool) != inside).sum()),
                          round(t["min"], 2), round(t["max"], 2), float(heights.min()) > 0, t.get("nodataCells"))
    expect = (0, round(float(z[inside].min()), 2), round(float(z[inside].max()), 2), True, int((~inside).sum()))
    check("clipped DEM: the no-data box is a mask, never ground (declared -9999)", seen[True] == expect, str(seen[True]))
    check("clipped DEM: an undeclared -9999 is recognised as no data too", seen[False] == expect, str(seen[False]))
    # A plain DEM gets no mask.
    plain = QgsRasterLayer(os.path.join(folder, "big_dem.tif"), "big")
    if plain.isValid():
        res = sx.SceneExporter(sx.ExportSpec(out_dir=os.path.join(folder, "plain_scene"), extent=plain.extent(),
                                             extent_crs=plain.crs(), dem=plain, max_cells=1024)).run()
        check("a DEM without holes gets no mask", "mask" not in res.manifest["terrain"] and
              not os.path.exists(os.path.join(folder, "plain_scene", "terrain_mask.bin")), str(res.manifest["terrain"]))


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


def test_results_after_reexport(folder):
    """A results GeoPackage belongs to its export: after a re-export with
    other features, values still land on the right buildings. A hand-added
    feature (NULL g3d_id) and a field that differs only in case do not
    break the next send."""
    from zero2geospatial3d.core import scene_export as sx
    from zero2geospatial3d.core.results import ResultWriter

    src = QgsVectorLayer(f"Polygon?crs={CRS}&field=name:string(10)&field=Flood_Depth_M:double", "Reexport blocks", "memory")
    feats = []
    for k, name in enumerate(("b0", "b1", "b2")):
        f = QgsFeature(src.fields())
        f.setGeometry(square(X0 + 50 + 100 * k, Y0 - 50, 10))
        f.setAttributes([name, None])
        feats.append(f)
    src.dataProvider().addFeatures(feats)
    QgsProject.instance().addMapLayer(src)
    out = os.path.join(folder, "reexport_scene")

    def export(xmin):
        spec = sx.ExportSpec(out_dir=out, extent=QgsRectangle(xmin, Y0 - 100, X0 + 300, Y0), extent_crs=src.crs(),
                             layers=[sx.LayerSpec(src, sx.ROLE_BUILDINGS, "9")])
        sx.SceneExporter(spec).run()
        return ResultWriter(out)

    def values_by_name(field):
        lyr = next(lyr for lyr in QgsProject.instance().mapLayers().values() if lyr.name() == "Reexport blocks (3D results)")
        return {f["name"]: f[field] for f in lyr.getFeatures()}, lyr

    writer = export(X0)
    writer.handle({"type": "features", "layer": "L1", "fields": {"sun_h": {"values": {"1": 1.0, "2": 2.0, "3": 3.0}}}})
    writer = export(X0 + 100)          # b0 is outside now: viewer ids 1, 2 are b1, b2
    order = [src.getFeature(fid)["name"] for fid in json.loads(Path(out, "L1.ids.json").read_text())]
    writer.handle({"type": "features", "layer": "L1", "fields": {"sun_h": {"values": {"1": 10.0, "2": 20.0}}}})
    got, lyr = values_by_name("sun_h")
    check("re-export: values land on the buildings the viewer ids now stand for",
          order == ["b1", "b2"] and got.get("b1") == 10.0 and got.get("b2") == 20.0 and "b0" not in got, f"{order} {got}")
    extra = QgsFeature(lyr.fields())
    extra.setGeometry(square(X0 + 250, Y0 - 80, 5))
    lyr.dataProvider().addFeatures([extra])
    msg = ""
    try:
        msg = writer.handle({"type": "features", "layer": "L1", "fields": {"flood_depth_m": {"values": {"1": 0.7}}}})
        ok = values_by_name("Flood_Depth_M")[0].get("b1") == 0.7
    except Exception as exc:  # noqa: BLE001
        ok, msg = False, repr(exc)
    check("results: a feature without g3d_id is skipped; a field differing in case is reused", ok, msg)


def test_roads(folder):
    """A road layer: Roads role by name, a Traffic expression from lanes, the
    guess follows a role change, and the export carries the traffic."""
    from zero2geospatial3d.core import scene_export as sx
    from zero2geospatial3d.ui.dock import LayerRow, guess_height_expression, guess_role

    roads = QgsVectorLayer(f"LineString?crs={CRS}&field=lanes:integer&field=h:double", "Main roads", "memory")
    feats = []
    for y, lanes in ((Y0 - 120, 4), (Y0 - 320, 2)):
        f = QgsFeature(roads.fields())
        f.setGeometry(QgsGeometry.fromPolylineXY([QgsPointXY(X0 + 20, y), QgsPointXY(X0 + 480, y)]))
        f.setAttributes([lanes, 3.0])
        feats.append(f)
    roads.dataProvider().addFeatures(feats)
    role, checked = guess_role(roads)
    check("role guess: a line layer named 'roads' is a noise and traffic source", role == sx.ROLE_ROADS and checked,
          f"{role} {checked}")
    check("traffic guess: lanes, not the height field", guess_height_expression(roads, role) == '"lanes"',
          guess_height_expression(roads, role))
    row = LayerRow(roads)
    ok = row.height_label.text() == "Traffic" and row.height.expression() == '"lanes"'
    row.role.setCurrentIndex(row.role.findData(sx.ROLE_WALLS))
    ok_switch = row.height_label.text() == "Height" and row.height.expression() == '"h"'
    check("panel row: Traffic for roads; an unedited guess follows the role", ok and ok_switch,
          f"{row.height_label.text()} {row.height.expression()}")
    row.deleteLater()
    QgsProject.instance().addMapLayer(roads)
    out = os.path.join(folder, "roads_scene")
    spec = sx.ExportSpec(out_dir=out, extent=QgsRectangle(X0, Y0 - 500, X0 + 500, Y0), extent_crs=roads.crs(),
                         layers=[sx.LayerSpec(roads, sx.ROLE_ROADS, '"lanes"')])
    result = sx.SceneExporter(spec).run()
    entry = result.manifest["layers"][0]
    feats = json.loads(Path(out, entry["file"]).read_text(encoding="utf-8"))["features"]
    check("export: roads keep their role and traffic per feature",
          entry["role"] == "roads" and entry["defaultHeight"] == 1.0
          and sorted(f["properties"]["_h"] for f in feats) == [2.0, 4.0],
          f"{entry['role']} {[f['properties']['_h'] for f in feats]}")


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
        test_roads(folder)
        test_results_after_reexport(folder)
        test_detail_limit(folder)
        test_clipped_dem(folder)
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
