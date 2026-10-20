# -*- coding: utf-8 -*-
"""Viewer results -> QGIS layers.

Two payload types arrive from the viewer (see ``web/src/ui/qgis_link.js``):

``grid``      a raster on the scene grid (base64 float32, NaN = no data),
              written as a GeoTIFF and added with a pseudocolour ramp, or
              a palette for class rasters;
``features``  per-feature values for one exported layer, written as fields
              of ``results/<layer>_results.gpkg`` (a copy of the exported
              features that keeps every source attribute).

``style`` carries the viewer's own colours so QGIS draws what the viewer
drew: ``stops`` (hex colours of the ramp, already reversed where the viewer
reverses it) or ``categories`` (``[{value, color, label}]``, with ``other``
for every remaining value), and ``field`` to say which field styles a layer.

Everything here runs on the QGIS main thread.
"""
from __future__ import annotations

import base64
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
        existing = {f.name() for f in target.fields()}
        used = set(existing)
        new_fields, names = [], {}
        for raw_name in fields_in:
            key = _key(raw_name)
            if key in existing:
                names[raw_name] = key
                continue
            name = geo.field_name(key, used)
            names[raw_name] = name
            new_fields.append(make_field(name, "double"))
        if new_fields:
            provider.addAttributes(new_fields)
            target.updateFields()
        index = {name: target.fields().indexOf(name) for name in names.values()}
        # The join key is the last g3d_id* column: a re-exported results layer
        # already carries an older g3d_id, and ours was appended after it.
        id_candidates = [i for i, f in enumerate(target.fields()) if f.name().startswith("g3d_id")]
        if not id_candidates:
            raise ResultError(f"'{target.name()}' has no g3d_id column")
        id_field = id_candidates[-1]
        by_viewer_id = {}
        for feature in target.getFeatures(QgsFeatureRequest().setSubsetOfAttributes([id_field])):
            by_viewer_id[int(feature[id_field])] = feature.id()
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
        path = os.path.join(self.results_dir, f"{entry['id']}_{stem}_results.gpkg")
        layer_name = f"{entry['name']} (3D results)"
        for layer in QgsProject.instance().mapLayers().values():
            if isinstance(layer, QgsVectorLayer) and layer.source().split("|", 1)[0].replace("\\", "/") == \
                    path.replace("\\", "/"):
                return layer
        if not os.path.isfile(path):
            self._create_result_gpkg(entry, path)
        layer = QgsVectorLayer(path, layer_name, "ogr")
        if not layer.isValid():
            raise ResultError(f"cannot open {path}")
        self._add_to_group(layer)
        return layer

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
