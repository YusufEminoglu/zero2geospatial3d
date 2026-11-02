# -*- coding: utf-8 -*-
"""Viewer results -> QGIS layers.

Two payload types arrive from the viewer (see ``web/src/ui/qgis_link.js``):

``grid``      a raster on the scene grid (base64 float32, NaN = no data),
              written as a GeoTIFF and added with a pseudocolour ramp, or
              a palette for class rasters;
``features``  per-feature values for one exported layer, written as fields
              of ``results/<layer>_results_<export>.gpkg`` (a copy of the
              exported features that keeps every source attribute; one
              file per set of exported features, see ``_result_layer``).

``style`` carries the viewer's own colours so QGIS draws what the viewer
drew: ``stops`` (hex colours of the ramp, already reversed where the viewer
reverses it) or ``categories`` (``[{value, color, label}]``, with ``other``
for every remaining value), and ``field`` to say which field styles a layer.

Everything here runs on the QGIS main thread.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import math
import os
import re

from qgis.core import (
    QgsCategorizedSymbolRenderer,
    QgsClassificationJenks,
    QgsColorRampShader,
    QgsCoordinateReferenceSystem,
    QgsFeature,
    QgsFeatureRequest,
    QgsGradientColorRamp,
    QgsGradientStop,
    QgsGraduatedSymbolRenderer,
    QgsPalettedRasterRenderer,
    QgsProject,
    QgsRasterLayer,
    QgsRendererCategory,
    QgsRasterShader,
    QgsSingleBandPseudoColorRenderer,
    QgsStyle,
    QgsSymbol,
    QgsVectorFileWriter,
    QgsVectorLayer,
)
from qgis.PyQt.QtGui import QColor

from . import geo
from .qgis_compat import make_field

GROUP_NAME = "02 Geo3D results"
_KEY_RE = re.compile(r"[^a-z0-9_]")
RAMPS = {"viridis": "Viridis", "magma": "Magma", "inferno": "Inferno", "rdylbu": "RdYlBu",
         "spectral": "Spectral", "blues": "Blues", "reds": "Reds", "turbo": "Turbo",
         "rdbu": "RdBu", "greens": "Greens", "greys": "Greys"}


class ResultError(RuntimeError):
    pass


def _color(value, default: str = "#cccccc") -> QColor:
    color = QColor(str(value or default))
    return color if color.isValid() else QColor(default)


def ramp_from_style(style: dict):
    """The colour ramp a style asks for: the viewer's own stops, else a
    named ramp of the QGIS default style (None when neither exists)."""
    stops = [c for c in (style.get("stops") or []) if QColor(str(c)).isValid()]
    if len(stops) >= 2:
        colors = [_color(c) for c in stops]
        inner = [QgsGradientStop(k / (len(colors) - 1), colors[k]) for k in range(1, len(colors) - 1)]
        return QgsGradientColorRamp(colors[0], colors[-1], False, inner)
    key = str(style.get("ramp") or "viridis").lower()
    if key.endswith("-r"):
        ramp = QgsStyle.defaultStyle().colorRamp(RAMPS.get(key[:-2], "Viridis"))
        if ramp is not None:
            ramp.invert()
        return ramp
    return QgsStyle.defaultStyle().colorRamp(RAMPS.get(key, "Viridis"))


def categories_from_style(style: dict) -> list:
    """[(value, QColor, label)] from a style's categories; bad entries dropped."""
    out = []
    for item in style.get("categories") or []:
        value = _num((item or {}).get("value"), None)
        if value is None:
            continue
        out.append((value, _color(item.get("color")), str(item.get("label") or _fmt_value(value))))
    return out


def _fmt_value(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def decode_float32(data_b64: str, count: int):
    import numpy as np

    raw = base64.b64decode(data_b64)
    if len(raw) != count * 4:
        raise ResultError(f"grid payload has {len(raw)} bytes, expected {count * 4}")
    return np.frombuffer(raw, dtype="<f4").astype(np.float32)


class ResultWriter:
    def __init__(self, scene_dir: str, log=None):
        self.scene_dir = scene_dir
        self.results_dir = os.path.join(scene_dir, "results")
        self._log = log or (lambda msg: None)
        with open(os.path.join(scene_dir, "scene.json"), "r", encoding="utf-8") as handle:
            self.manifest = json.load(handle)
        self.crs = QgsCoordinateReferenceSystem(self.manifest["crs"]["authid"])
        if not self.crs.isValid():
            self.crs = QgsCoordinateReferenceSystem.fromWkt(self.manifest["crs"]["wkt"])
        self.origin = self.manifest["origin"]

    # ------------------------------------------------------------ dispatch
    def handle(self, payload: dict) -> str:
        kind = payload.get("type")
        if kind == "grid":
            return self.write_grid(payload)
        if kind == "features":
            return self.write_features(payload)
        if kind == "routes":
            return self.write_routes(payload)
        raise ResultError(f"unknown result type {kind!r}")

    # ------------------------------------------------------------ rasters
    def write_grid(self, payload: dict) -> str:
        from osgeo import gdal
        import numpy as np

        grid = payload.get("grid") or {}
        cols, rows = int(grid["cols"]), int(grid["rows"])
        cell = float(grid["cell"])
        if cols <= 0 or rows <= 0 or cols * rows > 40_000_000 or not cell > 0:
            raise ResultError("grid size out of range")
        values = decode_float32(payload["data"], cols * rows).reshape(rows, cols)
        name = str(payload.get("name") or "result")
        key = _key(payload.get("key") or name)
        os.makedirs(self.results_dir, exist_ok=True)
        path = _unique_path(os.path.join(self.results_dir, f"{key}.tif"))
        ox, oy = self.origin
        left = ox + float(grid["minX"]) - cell / 2
        top = oy + float(grid["maxY"]) + cell / 2
        driver = gdal.GetDriverByName("GTiff")
        dataset = driver.Create(path, cols, rows, 1, gdal.GDT_Float32,
                                options=["COMPRESS=DEFLATE", "TILED=YES", "PREDICTOR=3"])
        if dataset is None:
            raise ResultError(f"cannot create {path}")
        dataset.SetGeoTransform((left, cell, 0.0, top, 0.0, -cell))
        dataset.SetProjection(self.crs.toWkt())
        band = dataset.GetRasterBand(1)
        band.SetNoDataValue(float("nan"))
        band.WriteArray(values)
        unit = str(payload.get("unit") or "")
        band.SetDescription(f"{name} [{unit}]" if unit else name)
        dataset.FlushCache()
        dataset = None
        finite = values[np.isfinite(values)]
        style = payload.get("style") or {}
        vmin = _num(style.get("min"), float(finite.min()) if finite.size else 0.0)
        vmax = _num(style.get("max"), float(finite.max()) if finite.size else 1.0)
        layer = QgsRasterLayer(path, name)
        if not layer.isValid():
            raise ResultError(f"QGIS cannot open {path}")
        categories = categories_from_style(style)
        if categories:
            self._style_palette(layer, categories)
        else:
            self._style_raster(layer, vmin, vmax, style)
        self._add_to_group(layer)
        return f"Added raster '{name}' ({cols} x {rows}, {cell:g} m)."

    def _style_palette(self, layer: QgsRasterLayer, categories: list) -> None:
        """Class rasters (aspect, land classes, visible / not visible) as a palette."""
        classes = [QgsPalettedRasterRenderer.Class(value, color, label) for value, color, label in categories]
        layer.setRenderer(QgsPalettedRasterRenderer(layer.dataProvider(), 1, classes))

    def _style_raster(self, layer: QgsRasterLayer, vmin: float, vmax: float, style: dict) -> None:
        if not (math.isfinite(vmin) and math.isfinite(vmax)) or vmax <= vmin:
            vmax = vmin + 1.0
        ramp = ramp_from_style(style)
        if ramp is None:
            self._log(f"Colour ramp '{style.get('ramp')}' is missing from the QGIS style; the raster keeps the default look.")
            return
        shader_fn = QgsColorRampShader(vmin, vmax, ramp)
        shader_fn.classifyColorRamp(9)
        shader = QgsRasterShader()
        shader.setRasterShaderFunction(shader_fn)
        renderer = QgsSingleBandPseudoColorRenderer(layer.dataProvider(), 1, shader)
        renderer.setClassificationMin(vmin)
        renderer.setClassificationMax(vmax)
        layer.setRenderer(renderer)

    # ------------------------------------------------------------ features
    def write_features(self, payload: dict) -> str:
        layer_key = str(payload.get("layer") or "")
        entry = next((e for e in self.manifest.get("layers", []) if e["id"] == layer_key), None)
        if entry is None:
            raise ResultError(f"layer {layer_key!r} is not part of this scene")
        fields_in = payload.get("fields") or {}
        if not isinstance(fields_in, dict) or not fields_in:
            raise ResultError("no result fields")
        target = self._result_layer(entry)
        provider = target.dataProvider()
        # GeoPackage column names are case-insensitive: match them that way.
        existing = {f.name().lower(): f.name() for f in target.fields()}
        used = set(existing)
        new_fields, names = [], {}
        for raw_name in fields_in:
            key = _key(raw_name)
            if key in existing:
                names[raw_name] = existing[key]
                continue
            name = geo.field_name(key, used)
            names[raw_name] = name
            new_fields.append(make_field(name, "double"))
        if new_fields:
            if not provider.addAttributes(new_fields):
                raise ResultError(f"cannot add the fields {', '.join(f.name() for f in new_fields)} to '{target.name()}'")
            target.updateFields()
        index = {name: target.fields().indexOf(name) for name in names.values()}
        missing = [name for name, i in index.items() if i < 0]
        if missing:
            raise ResultError(f"'{target.name()}' has no field {', '.join(missing)}")
        # The join key is the last g3d_id* column: a re-exported results layer
        # already carries an older g3d_id, and ours was appended after it.
        id_candidates = [i for i, f in enumerate(target.fields()) if f.name().startswith("g3d_id")]
        if not id_candidates:
            raise ResultError(f"'{target.name()}' has no g3d_id column")
        id_field = id_candidates[-1]
        by_viewer_id = {}
        for feature in target.getFeatures(QgsFeatureRequest().setSubsetOfAttributes([id_field])):
            try:
                by_viewer_id[int(feature[id_field])] = feature.id()
            except (TypeError, ValueError):
                continue  # a feature added by hand has no viewer id
        changes: dict = {}
        updated = 0
        for raw_name, spec in fields_in.items():
            values = (spec or {}).get("values") or {}
            col = index[names[raw_name]]
            for vid, value in values.items():
                try:
                    fid = by_viewer_id[int(vid)]
                except (KeyError, ValueError):
                    continue
                number = _num(value, None)
                changes.setdefault(fid, {})[col] = number
                updated += 1
        if changes:
            provider.changeAttributeValues(changes)
        target.triggerRepaint()
        style = payload.get("style") or {}
        wanted = style.get("field")
        styled = names.get(wanted) if wanted in names else names[list(fields_in)[-1]]
        categories = categories_from_style(style)
        if categories:
            self._style_categories(target, styled, categories, style.get("other") or {})
        else:
            self._style_graduated(target, styled, style)
        self._style_3d(target, entry)
        return f"Updated {len(changes)} features of '{target.name()}' with {', '.join(names.values())}."

    def _result_layer(self, entry: dict) -> QgsVectorLayer:
        os.makedirs(self.results_dir, exist_ok=True)
        stem = geo.safe_name(entry["name"], entry["id"])
        # The g3d_id of a results file belongs to the export that created it:
        # after a re-export with other features (a smaller area, an edited
        # layer) the same ids name other buildings. The file name carries the
        # export's stamp, so such a re-export starts a new file and the same
        # features keep theirs. Nothing is deleted or renamed.
        prefix = f"{entry['id']}_{stem}_results"
        path = os.path.join(self.results_dir, f"{prefix}_{self._export_token(entry)[:10]}.gpkg")
        layer_name = f"{entry['name']} (3D results)"
        norm = path.replace("\\", "/")
        older = []
        for layer in list(QgsProject.instance().mapLayers().values()):
            if not isinstance(layer, QgsVectorLayer):
                continue
            src = layer.source().split("|", 1)[0].replace("\\", "/")
            if src == norm:
                return layer
            if os.path.dirname(src) == os.path.dirname(norm) and os.path.basename(src).startswith(prefix):
                older.append(layer)
        # Results of an earlier export of this layer stay on disk; their
        # layers leave the project so the names do not mix up.
        for layer in older:
            QgsProject.instance().removeMapLayer(layer.id())
        if older:
            self._log(f"Results of an earlier export of '{entry['name']}' stay in their file; "
                      f"new results go to '{os.path.basename(path)}'.")
        if not os.path.isfile(path):
            self._create_result_gpkg(entry, path)
        layer = QgsVectorLayer(path, layer_name, "ogr")
        if not layer.isValid():
            raise ResultError(f"cannot open {path}")
        self._add_to_group(layer)
        return layer

    def _export_token(self, entry: dict) -> str:
        """What the viewer ids of a layer stand for: its source layer and the
        source feature ids in viewer-id order (the layer's ids.json)."""
        ids_path = os.path.join(self.scene_dir, f"{entry['id']}.ids.json")
        digest = hashlib.sha256(str(entry.get("sourceLayerId", "")).encode("utf-8"))
        with contextlib.suppress(OSError), open(ids_path, "rb") as handle:
            digest.update(handle.read())
        return digest.hexdigest()

    def _create_result_gpkg(self, entry: dict, path: str) -> None:
        source = QgsProject.instance().mapLayer(entry.get("sourceLayerId", ""))
        ids_path = os.path.join(self.scene_dir, f"{entry['id']}.ids.json")
        with open(ids_path, "r", encoding="utf-8") as handle:
            fids = json.load(handle)
        if source is None or not isinstance(source, QgsVectorLayer):
            raise ResultError(f"source layer '{entry['name']}' is no longer in the project")
        uri = f"{_wkb_string(source)}?crs={source.crs().authid()}"
        memory = QgsVectorLayer(uri, entry["name"], "memory")
        mprov = memory.dataProvider()
        fields = list(source.fields())
        used = {f.name().lower() for f in fields}
        mprov.addAttributes(fields + [make_field(geo.field_name("g3d_id", used), "int")])
        memory.updateFields()
        order = {fid: index + 1 for index, fid in enumerate(fids)}
        out = []
        for feature in source.getFeatures(QgsFeatureRequest().setFilterFids(list(order))):
            copy = QgsFeature(memory.fields())
            copy.setGeometry(feature.geometry())
            copy.setAttributes(list(feature.attributes()) + [order[feature.id()]])
            out.append(copy)
        mprov.addFeatures(out)
        options = QgsVectorFileWriter.SaveVectorOptions()
        options.driverName = "GPKG"
        options.layerName = geo.safe_name(entry["name"], "results")
        options.fileEncoding = "UTF-8"
        result = QgsVectorFileWriter.writeAsVectorFormatV3(
            memory, path, QgsProject.instance().transformContext(), options)
        if result[0] != QgsVectorFileWriter.WriterError.NoError:
            raise ResultError(f"cannot write {path}: {result[1]}")

    def _style_categories(self, layer: QgsVectorLayer, field: str, categories: list, other: dict) -> None:
        """Fixed classes (pass / fail) with the viewer's colours; ``other`` covers
        every remaining value, empty ones included (buildings not checked)."""
        try:
            cats = []
            for value, color, label in categories:
                symbol = QgsSymbol.defaultSymbol(layer.geometryType())
                symbol.setColor(color)
                cats.append(QgsRendererCategory(value, symbol, label))
            if other:
                symbol = QgsSymbol.defaultSymbol(layer.geometryType())
                symbol.setColor(_color(other.get("color"), "#c9c9c9"))
                cats.append(QgsRendererCategory(None, symbol, str(other.get("label") or "Other")))
            layer.setRenderer(QgsCategorizedSymbolRenderer(field, cats))
            layer.triggerRepaint()
        except Exception as exc:  # noqa: BLE001 - styling is optional, but say so
            self._log(f"Could not style '{layer.name()}' by {field}: {exc}")

    def _style_graduated(self, layer: QgsVectorLayer, field: str, style: dict) -> None:
        ramp = ramp_from_style(style)
        if ramp is None:
            return
        try:
            renderer = QgsGraduatedSymbolRenderer(field)
            renderer.setSourceColorRamp(ramp)
            renderer.setClassificationMethod(QgsClassificationJenks())
            renderer.updateClasses(layer, 7)
            layer.setRenderer(renderer)
            layer.triggerRepaint()
        except Exception as exc:  # noqa: BLE001 - styling is optional, but say so
            self._log(f"Could not style '{layer.name()}' by {field}: {exc}")

    def _style_3d(self, layer: QgsVectorLayer, entry: dict) -> None:
        """Extrude the results copy in QGIS's 3D view, coloured like its 2D classes."""
        if entry.get("kind") != "polygon":
            return
        try:
            from .qgis3d import style_layer_3d

            style_layer_3d(layer, entry.get("heightExpr") or "")
        except Exception as exc:  # noqa: BLE001 - the 3D style is a bonus, but say so
            self._log(f"No 3D style for '{layer.name()}': {exc}")

    # ------------------------------------------------------------ routes
    def write_routes(self, payload: dict) -> str:
        from qgis.core import QgsGeometry, QgsPointXY

        routes = payload.get("routes") or []
        if not isinstance(routes, list) or not routes:
            raise ResultError("no route geometries in payload")
        name = str(payload.get("name") or "Pedestrian routes")
        key = _key(payload.get("key") or name)
        os.makedirs(self.results_dir, exist_ok=True)
        path = _unique_path(os.path.join(self.results_dir, f"{key}.gpkg"))
        uri = f"LineString?crs={self.crs.authid()}"
        memory = QgsVectorLayer(uri, name, "memory")
        mprov = memory.dataProvider()
        mprov.addAttributes([
            make_field("route_type", "string"),
            make_field("label", "string"),
            make_field("length_m", "double"),
            make_field("mean_utci_c", "double"),
            make_field("shade_pct", "double"),
            make_field("mean_gvi_pct", "double"),
            make_field("mean_noise_dba", "double"),
            make_field("walk_score", "double"),
        ])
        memory.updateFields()
        ox, oy = self.origin
        feats = []
        cats = []
        for item in routes:
            coords = (item or {}).get("coords") or []
            if len(coords) < 2:
                continue
            pts = [QgsPointXY(float(pt[0]) + ox, float(pt[1]) + oy) for pt in coords if len(pt) >= 2]
            if len(pts) < 2:
                continue
            rtype = str(item.get("route_type") or "route")
            rlabel = str(item.get("label") or rtype)
            feat = QgsFeature(memory.fields())
            feat.setGeometry(QgsGeometry.fromPolylineXY(pts))
            feat.setAttributes([
                rtype,
                rlabel,
                _num(item.get("length_m"), None),
                _num(item.get("mean_utci_c"), None),
                _num(item.get("shade_pct"), None),
                _num(item.get("mean_gvi_pct"), None),
                _num(item.get("mean_noise_dba"), None),
                _num(item.get("walk_score"), None),
            ])
            feats.append(feat)
            cats.append((rtype, _color(item.get("color"), "#1d8f5f"), rlabel))
        if not feats:
            raise ResultError("no valid route lines in payload")
        mprov.addFeatures(feats)
        options = QgsVectorFileWriter.SaveVectorOptions()
        options.driverName = "GPKG"
        options.layerName = geo.safe_name(name, "routes")
        options.fileEncoding = "UTF-8"
        res = QgsVectorFileWriter.writeAsVectorFormatV3(
            memory, path, QgsProject.instance().transformContext(), options)
        if res[0] != QgsVectorFileWriter.WriterError.NoError:
            raise ResultError(f"cannot write {path}: {res[1]}")
        layer = QgsVectorLayer(path, name, "ogr")
        if not layer.isValid():
            raise ResultError(f"cannot open {path}")
        with contextlib.suppress(Exception):
            rcats = []
            for rtype, color, rlabel in cats:
                sym = QgsSymbol.defaultSymbol(layer.geometryType())
                sym.setColor(color)
                with contextlib.suppress(Exception):
                    sym.setWidth(1.1)
                rcats.append(QgsRendererCategory(rtype, sym, rlabel))
            layer.setRenderer(QgsCategorizedSymbolRenderer("route_type", rcats))
        self._add_to_group(layer)
        return f"Added route layer '{name}' ({len(feats)} route(s))."

    # ------------------------------------------------------------ project
    def _add_to_group(self, layer) -> None:
        project = QgsProject.instance()
        root = project.layerTreeRoot()
        group = root.findGroup(GROUP_NAME) or root.insertGroup(0, GROUP_NAME)
        project.addMapLayer(layer, False)
        group.insertLayer(0, layer)


def select_in_qgis(manifest: dict, scene_dir: str, payload: dict) -> str:
    """Select the source features of a viewer pick: {"layer": "L1", "ids": [..]}."""
    layer_key = str(payload.get("layer") or "")
    entry = next((e for e in manifest.get("layers", []) if e["id"] == layer_key), None)
    if entry is None:
        return ""
    source = QgsProject.instance().mapLayer(entry.get("sourceLayerId", ""))
    if source is None:
        return f"Layer '{entry['name']}' is no longer in the project."
    with open(os.path.join(scene_dir, f"{layer_key}.ids.json"), "r", encoding="utf-8") as handle:
        fids = json.load(handle)
    chosen = []
    for vid in payload.get("ids") or []:
        try:
            chosen.append(int(fids[int(vid) - 1]))
        except (IndexError, ValueError, TypeError):
            continue
    source.selectByIds(chosen)
    return f"Selected {len(chosen)} feature(s) in '{source.name()}'."


def viewer_ids_for_selection(manifest: dict, scene_dir: str) -> dict:
    """QGIS selection -> {"L1": [viewer ids]} for the layers in the scene."""
    out = {}
    for entry in manifest.get("layers", []):
        source = QgsProject.instance().mapLayer(entry.get("sourceLayerId", ""))
        if source is None or not source.selectedFeatureCount():
            continue
        path = os.path.join(scene_dir, f"{entry['id']}.ids.json")
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            fids = json.load(handle)
        lookup = {fid: index + 1 for index, fid in enumerate(fids)}
        out[entry["id"]] = [lookup[f] for f in source.selectedFeatureIds() if f in lookup]
    return out


def _wkb_string(layer: QgsVectorLayer) -> str:
    from .scene_export import geometry_kind

    return {"point": "MultiPoint", "line": "MultiLineString", "polygon": "MultiPolygon"}.get(
        geometry_kind(layer), "MultiPolygon")


def _key(text) -> str:
    key = _KEY_RE.sub("_", str(text or "").lower()).strip("_")
    return (key or "result")[:40]


def _num(value, default):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    k = 2
    while os.path.exists(f"{stem}_{k}{ext}"):
        k += 1
    return f"{stem}_{k}{ext}"


def _scene_result_summary(manifest: dict, project: QgsProject) -> list[tuple[str, str]]:
    """Collect (label, summary_value) rows from the scene manifest and ``02 Geo3D results`` group."""
    rows: list[tuple[str, str]] = []
    grid = manifest.get("grid") or {}
    if grid.get("cols") and grid.get("rows"):
        rows.append(("Scene grid", f"{grid['cols']} × {grid['rows']} @ {float(grid.get('cell', 1)):g} m"))
    terrain = manifest.get("terrain")
    if isinstance(terrain, dict) and "min" in terrain and "max" in terrain:
        rows.append(("Terrain elevation", f"{float(terrain['min']):.1f} – {float(terrain['max']):.1f} m"))
    weather = manifest.get("weather")
    if isinstance(weather, dict) and weather.get("source"):
        rows.append(("Weather (EPW)", str(weather["source"])))
    for entry in manifest.get("layers") or []:
        rows.append((f"3D {entry.get('role', 'layer')}: {entry.get('name', '')}", f"{entry.get('count', 0)} features"))

    root = project.layerTreeRoot()
    group = root.findGroup(GROUP_NAME) if root is not None else None
    if group is not None:
        for tree_layer in group.findLayers():
            lyr = tree_layer.layer()
            if lyr is None or not lyr.isValid():
                continue
            if isinstance(lyr, QgsRasterLayer):
                stats_str = "raster result"
                with contextlib.suppress(Exception):
                    st = lyr.dataProvider().bandStatistics(1)
                    if math.isfinite(st.minimumValue) and math.isfinite(st.maximumValue):
                        stats_str = f"{st.minimumValue:.2f} – {st.maximumValue:.2f} (mean {st.mean:.2f})"
                rows.append((f"Raster: {lyr.name()}", stats_str))
            elif isinstance(lyr, QgsVectorLayer):
                rows.append((f"Vector: {lyr.name()}", f"{lyr.featureCount()} features"))
    return rows


def _enable_html_label(label) -> None:
    from qgis.core import QgsLayoutItemLabel

    mode = getattr(getattr(QgsLayoutItemLabel, "Mode", QgsLayoutItemLabel), "ModeHtml", 1)
    with contextlib.suppress(Exception):
        label.setMode(mode)


def validate_analysis_layout(layout, scene_dir: str = "") -> list[dict]:
    """Validate a Geo3D Print Layout and return a list of check dicts."""
    from qgis.core import (
        QgsLayoutItemLabel,
        QgsLayoutItemLegend,
        QgsLayoutItemMap,
        QgsLayoutItemScaleBar,
    )

    checks: list[dict] = []
    if layout is None:
        return [{"level": "error", "code": "no_layout", "message": "Layout is None."}]
    items = list(layout.items())
    maps = [i for i in items if isinstance(i, QgsLayoutItemMap)]
    legends = [i for i in items if isinstance(i, QgsLayoutItemLegend)]
    scalebars = [i for i in items if isinstance(i, QgsLayoutItemScaleBar)]
    labels = [i for i in items if isinstance(i, QgsLayoutItemLabel)]
    if not maps:
        checks.append({"level": "error", "code": "missing_map", "message": "Layout has no map item."})
    else:
        ext = maps[0].extent()
        if ext.isEmpty() or ext.width() <= 0 or ext.height() <= 0:
            checks.append({"level": "error", "code": "empty_map_extent", "message": "Map item has an empty extent."})
        else:
            checks.append({"level": "ok", "code": "map_ready", "message": "Map item has a valid scene extent."})
    if not legends:
        checks.append({"level": "warning", "code": "missing_legend", "message": "Layout has no legend item."})
    else:
        checks.append({"level": "ok", "code": "legend_ready", "message": "Legend item is present."})
    if not scalebars:
        checks.append({"level": "warning", "code": "missing_scalebar", "message": "Layout has no scale bar."})
    else:
        checks.append({"level": "ok", "code": "scalebar_ready", "message": "Scale bar is linked to the map."})
    if len(labels) < 2:
        checks.append({"level": "warning", "code": "missing_summary_card",
                       "message": "Layout is missing the title banner or HTML KPI summary card."})
    else:
        checks.append({"level": "ok", "code": "summary_card_ready",
                       "message": "Title banner and HTML KPI summary card are present."})
    if scene_dir and not os.path.isfile(os.path.join(scene_dir, "scene.json")):
        checks.append({"level": "warning", "code": "missing_manifest",
                       "message": "Scene manifest (scene.json) was not found in scene_dir."})
    return checks


def build_qgis_analysis_layout(scene_dir: str, project: QgsProject | None = None,
                               layout_name: str = "") -> tuple[object, list[dict]]:
    """Create and register a publication-ready A4 Landscape ``QgsPrintLayout``
    summarizing the 3D scene and any ``02 Geo3D results`` layers.

    Returns ``(layout, validation_checks)``.
    """
    import html as _html
    from qgis.core import (
        QgsLayoutItemLabel,
        QgsLayoutItemLegend,
        QgsLayoutItemMap,
        QgsLayoutItemPage,
        QgsLayoutItemPicture,
        QgsLayoutItemScaleBar,
        QgsLayoutPoint,
        QgsLayoutSize,
        QgsPrintLayout,
        QgsRectangle,
        QgsUnitTypes,
    )

    project = project or QgsProject.instance()
    manifest_path = os.path.join(scene_dir, "scene.json") if scene_dir else ""
    if not manifest_path or not os.path.isfile(manifest_path):
        raise ResultError("Export or open a 3D scene first (scene.json not found).")
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    crs = QgsCoordinateReferenceSystem(manifest["crs"]["authid"])
    if not crs.isValid():
        crs = QgsCoordinateReferenceSystem.fromWkt(manifest["crs"]["wkt"])
    ox, oy = manifest.get("origin") or [0.0, 0.0]
    ext_info = manifest.get("extent") or {"minX": -250.0, "minY": -250.0, "maxX": 250.0, "maxY": 250.0}
    scene_rect = QgsRectangle(
        float(ox) + float(ext_info["minX"]),
        float(oy) + float(ext_info["minY"]),
        float(ox) + float(ext_info["maxX"]),
        float(oy) + float(ext_info["maxY"]),
    )
    scene_rect.scale(1.06)

    title = str(manifest.get("title") or "02 Geo3D Scene")
    base_name = layout_name.strip() or f"02 Geo3D — {title}"
    mgr = project.layoutManager()
    existing = mgr.layoutByName(base_name)
    if existing is not None:
        mgr.removeLayout(existing)

    layout = QgsPrintLayout(project)
    layout.initializeDefaults()
    layout.setName(base_name)
    mm = QgsUnitTypes.LayoutUnit.LayoutMillimeters

    pc = layout.pageCollection()
    if pc.pageCount() > 0:
        orient = getattr(getattr(QgsLayoutItemPage, "Orientation", QgsLayoutItemPage), "Landscape", 0)
        pc.page(0).setPageSize("A4", orient)

    # 1. Header Banner (HTML)
    geo_info = manifest.get("geo") or {}
    lat = float(geo_info.get("lat", 0.0))
    lon = float(geo_info.get("lon", 0.0))
    utc = float(geo_info.get("utcOffset", 0.0))
    created = str(manifest.get("created") or "")[:16].replace("T", " ")
    header = QgsLayoutItemLabel(layout)
    header.setId("geo3d_header_banner")
    _enable_html_label(header)
    header.setText(
        "<div style='font-family:Segoe UI,Arial,sans-serif;background:#162436;color:#ffffff;"
        "padding:6px 12px;border-radius:4px;'>"
        f"<div style='font-size:13pt;font-weight:700;'>02 Geo3D — {_html.escape(title)}</div>"
        f"<div style='font-size:8.5pt;color:#b9cde3;'>CRS: {_html.escape(crs.authid())} &nbsp;|&nbsp; "
        f"Center: {lat:.4f}°, {lon:.4f}° (UTC{utc:+g}) &nbsp;|&nbsp; Exported: {_html.escape(created)}</div>"
        "</div>"
    )
    header.attemptMove(QgsLayoutPoint(10.0, 8.0, mm))
    header.attemptResize(QgsLayoutSize(277.0, 14.0, mm))
    layout.addLayoutItem(header)

    # 2. Main Map Item
    map_item = QgsLayoutItemMap(layout)
    map_item.setId("geo3d_main_map")
    map_item.setCrs(crs)
    map_item.attemptMove(QgsLayoutPoint(10.0, 24.0, mm))
    map_item.attemptResize(QgsLayoutSize(188.0, 176.0, mm))
    map_item.zoomToExtent(scene_rect)
    map_item.setFrameEnabled(True)
    layout.addLayoutItem(map_item)

    # 3. Scale Bar
    scalebar = QgsLayoutItemScaleBar(layout)
    scalebar.setId("geo3d_scalebar")
    scalebar.setStyle("Single Box")
    scalebar.setLinkedMap(map_item)
    scalebar.setUnits(QgsUnitTypes.DistanceUnit.DistanceMeters)
    scalebar.setNumberOfSegments(2)
    scalebar.setNumberOfSegmentsLeft(0)
    with contextlib.suppress(Exception):
        scalebar.applyDefaultSize(QgsUnitTypes.DistanceUnit.DistanceMeters)
    scalebar.attemptMove(QgsLayoutPoint(14.0, 186.0, mm))
    scalebar.attemptResize(QgsLayoutSize(65.0, 11.0, mm))
    layout.addLayoutItem(scalebar)

    # 4. North Arrow
    north = QgsLayoutItemPicture(layout)
    north.setId("geo3d_north_arrow")
    with contextlib.suppress(Exception):
        north.setLinkedMap(map_item)
    north.attemptMove(QgsLayoutPoint(184.0, 27.0, mm))
    north.attemptResize(QgsLayoutSize(10.0, 10.0, mm))
    layout.addLayoutItem(north)

    # 5. HTML Scene & Analysis KPI Summary Card
    summary_rows = _scene_result_summary(manifest, project)
    tr_html = "".join(
        f"<tr><td style='padding:2px 4px;color:#334e68;font-weight:600;border-bottom:1px solid #e4ebf1;'>"
        f"{_html.escape(k)}</td>"
        f"<td style='padding:2px 4px;color:#102a43;text-align:right;border-bottom:1px solid #e4ebf1;'>"
        f"{_html.escape(v)}</td></tr>"
        for k, v in summary_rows[:12]
    )
    kpi_card = QgsLayoutItemLabel(layout)
    kpi_card.setId("geo3d_kpi_card")
    _enable_html_label(kpi_card)
    kpi_card.setText(
        "<div style='font-family:Segoe UI,Arial,sans-serif;background:#f7f9fc;border:1px solid #cbd5e1;"
        "border-radius:4px;padding:6px 8px;'>"
        "<div style='font-size:9.5pt;font-weight:700;color:#162436;margin-bottom:4px;'>"
        "3D Scene &amp; Environmental Summary</div>"
        f"<table style='width:100%;border-collapse:collapse;font-size:7.8pt;'>{tr_html}</table>"
        "</div>"
    )
    kpi_card.attemptMove(QgsLayoutPoint(202.0, 24.0, mm))
    kpi_card.attemptResize(QgsLayoutSize(85.0, 96.0, mm))
    layout.addLayoutItem(kpi_card)

    # 6. Legend Item
    legend = QgsLayoutItemLegend(layout)
    legend.setId("geo3d_legend")
    legend.setTitle("Legend")
    legend.setLinkedMap(map_item)
    legend.setFrameEnabled(True)
    legend.attemptMove(QgsLayoutPoint(202.0, 123.0, mm))
    legend.attemptResize(QgsLayoutSize(85.0, 77.0, mm))
    layout.addLayoutItem(legend)

    mgr.addLayout(layout)
    return layout, validate_analysis_layout(layout, scene_dir)

