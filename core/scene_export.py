# -*- coding: utf-8 -*-
"""QGIS layers -> scene package for the browser viewer.

Package layout (all inside one scene folder)::

    scene.json          manifest: CRS, origin, grids, layers, weather
    terrain.bin         DEM heights, float32 little-endian, rows north->south
    L<n>.geojson        one file per object layer, local metric coordinates
    L<n>.ids.json       source feature ids, index = viewer feature id - 1
    R<n>.bin            climate rasters resampled onto the terrain grid
    weather.epw         optional EnergyPlus weather file

Coordinates are local metres: projected CRS coordinate minus ``origin``.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import json
import math
import os
import shutil
from dataclasses import dataclass, field

from qgis.core import (
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsExpression,
    QgsExpressionContext,
    QgsExpressionContextUtils,
    QgsFeatureRequest,
    QgsGeometry,
    QgsPointXY,
    QgsProject,
    QgsRasterLayer,
    QgsRectangle,
    QgsRenderContext,
    QgsUnitTypes,
    QgsVectorLayer,
    QgsWkbTypes,
)

from . import geo

SCENE_FORMAT = "zero2geospatial3d-scene"
SCENE_VERSION = 1

ROLE_BUILDINGS = "buildings"
ROLE_TREES = "trees"
ROLE_POLES = "poles"
ROLE_WALLS = "walls"
ROLE_SURFACES = "surfaces"
ROLE_SECTIONS = "sections"
ROLE_PLATFORMS = "platforms"
ROLE_ROADS = "roads"

ROLES_BY_KIND = {
    "polygon": [ROLE_BUILDINGS, ROLE_SURFACES, ROLE_PLATFORMS],
    "line": [ROLE_WALLS, ROLE_ROADS, ROLE_SECTIONS],
    "point": [ROLE_TREES, ROLE_POLES],
}
ROLE_LABELS = {
    ROLE_BUILDINGS: "Buildings (extrude)",
    ROLE_SURFACES: "Ground surfaces (drape)",
    ROLE_PLATFORMS: "Platforms (cut/fill)",
    ROLE_WALLS: "Walls / fences (extrude)",
    ROLE_ROADS: "Roads (noise and traffic sources)",
    ROLE_SECTIONS: "Section lines",
    ROLE_TREES: "Trees",
    ROLE_POLES: "Poles / columns",
}
DEFAULT_HEIGHT = {
    ROLE_BUILDINGS: "9",
    ROLE_SURFACES: "0",
    ROLE_PLATFORMS: "0",
    ROLE_WALLS: "2",
    ROLE_ROADS: "1",
    ROLE_SECTIONS: "0",
    ROLE_TREES: "8",
    ROLE_POLES: "6",
}
DEFAULT_COLOR = {
    ROLE_BUILDINGS: "#d9d4cc",
    ROLE_SURFACES: "#9cc58a",
    ROLE_PLATFORMS: "#c9a46b",
    ROLE_WALLS: "#a39e96",
    ROLE_ROADS: "#ff4f2e",
    ROLE_SECTIONS: "#e4572e",
    ROLE_TREES: "#4f8a3c",
    ROLE_POLES: "#8d8d8d",
}
MAX_FEATURES_PER_LAYER = 120000
MAX_TEXT = 120


class ExportError(RuntimeError):
    pass


class ExportCancelled(ExportError):
    pass


@dataclass
class LayerSpec:
    layer: QgsVectorLayer
    role: str
    height_expr: str = ""
    color_mode: str = "qgis"          # "qgis" | "single"
    scenario: str = "both"            # "both" | "A" | "B"
    base_expr: str = ""               # optional bottom above the ground (OSM min_height)


@dataclass
class ExportSpec:
    out_dir: str
    extent: QgsRectangle
    extent_crs: QgsCoordinateReferenceSystem
    dem: QgsRasterLayer | None = None
    cell_size: float | None = None    # None -> automatic
    layers: list = field(default_factory=list)          # [LayerSpec]
    climate_rasters: list = field(default_factory=list)  # [QgsRasterLayer]
    epw_path: str = ""
    title: str = "Scene"
    max_cells: int = 2048             # longest side of the terrain grid (viewer tiles above 1024)


@dataclass
class ExportResult:
    scene_dir: str
    manifest: dict
    warnings: list


def geometry_kind(layer: QgsVectorLayer) -> str:
    """'point' | 'line' | 'polygon' | '' for a vector layer (QGIS 3 and 4)."""
    gtype = QgsWkbTypes.geometryType(layer.wkbType())
    value = int(getattr(gtype, "value", gtype))
    return {0: "point", 1: "line", 2: "polygon"}.get(value, "")


# ---------------------------------------------------------------- CRS
def choose_export_crs(spec: ExportSpec) -> QgsCoordinateReferenceSystem:
    """A projected CRS in metres: the DEM's, else a layer's or the project's,
    else the UTM zone of the extent's centre."""
    candidates = []
    if spec.dem is not None:
        candidates.append(spec.dem.crs())
    candidates.extend(ls.layer.crs() for ls in spec.layers)
    candidates.append(QgsProject.instance().crs())
    for crs in candidates:
        if crs.isValid() and not crs.isGeographic() and _is_metric(crs):
            return crs
    wgs = QgsCoordinateReferenceSystem("EPSG:4326")
    centre = _transform_rect(spec.extent, spec.extent_crs, wgs).center()
    return QgsCoordinateReferenceSystem(f"EPSG:{geo.utm_epsg_for(centre.x(), centre.y())}")


def _is_metric(crs: QgsCoordinateReferenceSystem) -> bool:
    text = ""
    with contextlib.suppress(Exception):
        text = QgsUnitTypes.toString(crs.mapUnits()).lower()
    return "meter" in text or "metre" in text


def _transform_rect(rect, src, dst) -> QgsRectangle:
    if src == dst:
        return QgsRectangle(rect)
    xform = QgsCoordinateTransform(src, dst, QgsProject.instance())
    return xform.transformBoundingBox(rect)


# ---------------------------------------------------------------- export
class SceneExporter:
    def __init__(self, spec: ExportSpec, progress=None, is_cancelled=None):
        self.spec = spec
        self._progress = progress or (lambda pct, msg: None)
        self._is_cancelled = is_cancelled or (lambda: False)
        self.warnings: list[str] = []

    def _step(self, pct: float, msg: str) -> None:
        if self._is_cancelled():
            raise ExportCancelled("Export cancelled.")
        self._progress(pct, msg)

    def run(self) -> ExportResult:
        spec = self.spec
        os.makedirs(spec.out_dir, exist_ok=True)
        self._clean_previous(spec.out_dir)
        crs = choose_export_crs(spec)
        extent = _transform_rect(spec.extent, spec.extent_crs, crs)
        width, height = extent.width(), extent.height()
        if width <= 1 or height <= 1:
            raise ExportError("The scene area is empty. Pick a DEM, a layer or a map view with an extent.")
        if max(width, height) > geo.MAX_SCENE_SIDE_M:
            raise ExportError(
                f"The scene area is {max(width, height) / 1000:.0f} km across; the limit is "
                f"{geo.MAX_SCENE_SIDE_M / 1000:.0f} km. Pick a smaller extent.")
        cell_size = spec.cell_size
        if not cell_size:
            # Automatic: the DEM's own resolution (never finer), else 1/512 of
            # the longest side; grid_shape still caps the grid at 1024 cells.
            if spec.dem is not None and spec.dem.width() > 0:
                dem_ext = _transform_rect(spec.dem.extent(), spec.dem.crs(), crs)
                cell_size = dem_ext.width() / spec.dem.width()
            else:
                cell_size = max(1.0, max(width, height) / 512)
        cols, rows, cell = geo.grid_shape(width, height, cell_size, max(256, min(4096, int(spec.max_cells))))
        if max(width, height) > geo.LARGE_SCENE_SIDE_M:
            self.warnings.append(
                f"Large scene ({max(width, height) / 1000:.1f} km across): the terrain grid is {cell:.0f} m. "
                "For detailed analyses draw a smaller analysis area in the viewer, or raise the detail limit.")
        cx, cy = extent.center().x(), extent.center().y()
        origin = (round(cx, 3), round(cy, 3))
        grid = {
            "cols": cols, "rows": rows, "cell": cell,
            # local coordinates of the first (north-west) cell centre
            "minX": -cols * cell / 2 + cell / 2,
            "maxY": rows * cell / 2 - cell / 2,
        }
        grid_extent = QgsRectangle(cx - cols * cell / 2, cy - rows * cell / 2,
                                   cx + cols * cell / 2, cy + rows * cell / 2)

        wgs = QgsCoordinateReferenceSystem("EPSG:4326")
        centre_ll = QgsCoordinateTransform(crs, wgs, QgsProject.instance()).transform(QgsPointXY(cx, cy))

        manifest = {
            "format": SCENE_FORMAT,
            "version": SCENE_VERSION,
            "title": spec.title,
            "created": _dt.datetime.now().isoformat(timespec="seconds"),
            "crs": {"authid": crs.authid(), "wkt": crs.toWkt()},
            "origin": list(origin),
            "extent": {"minX": -width / 2, "minY": -height / 2, "maxX": width / 2, "maxY": height / 2},
            "geo": {"lat": centre_ll.y(), "lon": centre_ll.x(),
                    "utcOffset": geo.choose_utc_offset(centre_ll.x(), _machine_standard_offset())},
            "grid": grid,
            "terrain": None,
            "layers": [],
            "rasters": [],
            "weather": None,
        }

        self._step(5, "Terrain ...")
        if spec.dem is not None:
            manifest["terrain"] = self._export_dem(spec.dem, crs, grid_extent, cols, rows)

        id_grids = []
        n_layers = max(1, len(spec.layers))
        for index, lspec in enumerate(spec.layers):
            self._step(15 + 60 * index / n_layers, f"Layer {lspec.layer.name()} ...")
            entry, polygons = self._export_layer(index + 1, lspec, crs, extent, origin)
            if entry is not None:
                manifest["layers"].append(entry)
                if lspec.role == ROLE_BUILDINGS and polygons:
                    id_grids.append((entry, polygons))

        for index, raster in enumerate(spec.climate_rasters):
            self._step(78 + 15 * index / max(1, len(spec.climate_rasters)), f"Climate raster {raster.name()} ...")
            entry = self._export_climate_raster(index + 1, raster, crs, grid_extent, cols, rows,
                                                origin, manifest["layers"], id_grids)
            if entry:
                manifest["rasters"].append(entry)

        if spec.epw_path:
            self._step(95, "Weather file ...")
            manifest["weather"] = self._copy_epw(spec.epw_path)

        manifest["warnings"] = self.warnings
        with open(os.path.join(spec.out_dir, "scene.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=1)
        self._step(100, "Scene ready.")
        return ExportResult(spec.out_dir, manifest, list(self.warnings))

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _clean_previous(out_dir: str) -> None:
        for name in os.listdir(out_dir):
            if name == "scene.json" or name == "terrain.bin" or name == "weather.epw" or (
                    name[:1] in ("L", "R") and name.endswith((".geojson", ".ids.json", ".bin"))):
                with contextlib.suppress(OSError):
                    os.remove(os.path.join(out_dir, name))

    def _warp(self, layer: QgsRasterLayer, crs, grid_extent: QgsRectangle, cols: int, rows: int,
              resample: str = "bilinear"):
        """Resample a raster's first band onto the scene grid -> float32 rows
        north->south, NaN where there is no data."""
        from osgeo import gdal  # QGIS ships GDAL; imported lazily for the tests
        import numpy as np

        source = layer.dataProvider().dataSourceUri()
        if layer.providerType() != "gdal":
            raise ExportError(f"Raster '{layer.name()}' is not a file raster (provider {layer.providerType()}).")
        src_path = source.split("|", 1)[0]
        dataset = gdal.Open(src_path)
        if dataset is None:
            raise ExportError(f"GDAL cannot open raster '{layer.name()}'.")
        src_srs = layer.crs().toWkt()
        options = gdal.WarpOptions(
            format="MEM",
            outputBounds=(grid_extent.xMinimum(), grid_extent.yMinimum(),
                          grid_extent.xMaximum(), grid_extent.yMaximum()),
            width=cols, height=rows,
            srcSRS=src_srs or None, dstSRS=crs.toWkt(),
            resampleAlg=resample, outputType=gdal.GDT_Float32,
            dstNodata=float("nan"), multithread=True,
        )
        warped = gdal.Warp("", dataset, options=options)
        if warped is None:
            raise ExportError(f"Could not resample raster '{layer.name()}'.")
        band = warped.GetRasterBand(1)
        values = band.ReadAsArray().astype(np.float32)
        src_nodata = dataset.GetRasterBand(1).GetNoDataValue()
        if src_nodata is not None and math.isfinite(src_nodata):
            values[values == np.float32(src_nodata)] = np.nan
        return values, warped

    def _export_dem(self, dem: QgsRasterLayer, crs, grid_extent, cols, rows) -> dict:
        from osgeo import gdal
        import numpy as np

        values, warped = self._warp(dem, crs, grid_extent, cols, rows)
        valid = np.isfinite(values)
        if not valid.any():
            raise ExportError("The DEM has no data inside the scene area.")
        if not valid.all():
            band = warped.GetRasterBand(1)
            band.WriteArray(values)
            band.SetNoDataValue(float("nan"))
            gdal.FillNodata(band, None, 200, 0)
            values = band.ReadAsArray().astype(np.float32)
            missing = ~np.isfinite(values)
            if missing.any():
                values[missing] = np.float32(np.nanmin(values))
            self.warnings.append(f"The DEM had {int((~valid).sum())} empty cells; they were filled by interpolation.")
        values.astype("<f4").tofile(os.path.join(self.spec.out_dir, "terrain.bin"))
        return {"file": "terrain.bin", "min": float(values.min()), "max": float(values.max()),
                "source": dem.name()}

    def _export_climate_raster(self, index, raster, crs, grid_extent, cols, rows, origin,
                               layer_entries, id_grids) -> dict | None:
        import numpy as np

        try:
            values, _ = self._warp(raster, crs, grid_extent, cols, rows)
        except ExportError as exc:
            self.warnings.append(str(exc))
            return None
        if not np.isfinite(values).any():
            self.warnings.append(f"Climate raster '{raster.name()}' has no data inside the scene area.")
            return None
        name = f"R{index}.bin"
        values.astype("<f4").tofile(os.path.join(self.spec.out_dir, name))
        key = "clim_" + geo.safe_name(raster.name(), f"r{index}").lower()[:24]
        # Zonal mean per building footprint, written into each building layer.
        for entry, polygons in id_grids:
            means = _zonal_means(values, polygons, grid_extent, cols, rows, origin)
            self._add_property(entry, key, means)
        finite = values[np.isfinite(values)]
        return {"id": f"R{index}", "name": raster.name(), "file": name, "field": key,
                "min": float(finite.min()), "max": float(finite.max())}

    def _add_property(self, entry: dict, key: str, values_by_id: dict) -> None:
        path = os.path.join(self.spec.out_dir, entry["file"])
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for feature in data["features"]:
            value = values_by_id.get(feature["properties"]["_id"])
            feature["properties"][key] = None if value is None else round(float(value), 4)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
        if not any(f["name"] == key for f in entry["fields"]):
            entry["fields"].append({"name": key, "type": "number"})

    def _copy_epw(self, path: str) -> dict | None:
        if not os.path.isfile(path):
            self.warnings.append(f"Weather file not found: {path}")
            return None
        target = os.path.join(self.spec.out_dir, "weather.epw")
        shutil.copyfile(path, target)
        return {"file": "weather.epw", "source": os.path.basename(path)}

    # ------------------------------------------------------------ vector layers
    def _export_layer(self, index: int, lspec: LayerSpec, crs, extent: QgsRectangle, origin):
        layer = lspec.layer
        kind = geometry_kind(layer)
        if not kind:
            self.warnings.append(f"Layer '{layer.name()}' has no geometry; skipped.")
            return None, None
        xform = QgsCoordinateTransform(layer.crs(), crs, QgsProject.instance())
        layer_extent = QgsCoordinateTransform(crs, layer.crs(), QgsProject.instance()).transformBoundingBox(extent)
        request = QgsFeatureRequest().setFilterRect(layer_extent)
        extent_geom = QgsGeometry.fromRect(extent)

        context = QgsExpressionContext()
        context.appendScopes(QgsExpressionContextUtils.globalProjectLayerScopes(layer))
        height_expr = QgsExpression(lspec.height_expr or DEFAULT_HEIGHT.get(lspec.role, "0"))
        if height_expr.hasParserError():
            raise ExportError(f"Height expression of '{layer.name()}' is invalid: {height_expr.parserErrorString()}")
        height_expr.prepare(context)
        base_expr = None
        if lspec.base_expr and lspec.role == ROLE_BUILDINGS:
            base_expr = QgsExpression(lspec.base_expr)
            if base_expr.hasParserError():
                raise ExportError(f"Bottom expression of '{layer.name()}' is invalid: {base_expr.parserErrorString()}")
            base_expr.prepare(context)
        # Parts of one building (OSM building:part) share a group id; the viewer
        # stands them on one common ground.
        group_index = layer.fields().indexOf("bldg_group") if lspec.role == ROLE_BUILDINGS else -1

        renderer, render_ctx = None, None
        if lspec.color_mode == "qgis" and layer.renderer() is not None:
            renderer = layer.renderer().clone()
            render_ctx = QgsRenderContext()
            render_ctx.expressionContext().appendScopes(QgsExpressionContextUtils.globalProjectLayerScopes(layer))
            renderer.startRender(render_ctx, layer.fields())

        fields = layer.fields()
        field_meta = []
        for fld in fields:
            ftype = "number" if fld.isNumeric() else "text"
            field_meta.append({"name": fld.name(), "type": ftype})
        default_color = DEFAULT_COLOR.get(lspec.role, "#cccccc")
        ox, oy = origin
        features, fids, polygons = [], [], {}
        eval_errors = 0
        try:
            for feature in layer.getFeatures(request):
                if len(features) >= MAX_FEATURES_PER_LAYER:
                    self.warnings.append(
                        f"Layer '{layer.name()}' was truncated at {MAX_FEATURES_PER_LAYER} features.")
                    break
                if len(features) % 2000 == 0:
                    self._check_cancel()
                geom = feature.geometry()
                if geom is None or geom.isEmpty():
                    continue
                geom = QgsGeometry(geom)
                if QgsWkbTypes.isCurvedType(geom.wkbType()):
                    geom = QgsGeometry(geom.constGet().segmentize())
                if geom.transform(xform) != 0:
                    continue
                coords = self._local_coords(geom, kind, extent_geom, ox, oy)
                if coords is None:
                    continue
                context.setFeature(feature)
                height = height_expr.evaluate(context)
                if height_expr.hasEvalError():
                    eval_errors += 1
                    height = None
                try:
                    height = float(height)
                    if not math.isfinite(height):
                        height = None
                except (TypeError, ValueError):
                    height = None
                color = default_color
                if renderer is not None:
                    render_ctx.expressionContext().setFeature(feature)
                    color = self._symbol_color(renderer, feature, render_ctx) or default_color
                fid = len(features) + 1
                props = {"_id": fid, "_h": None if height is None else round(max(0.0, height), 3), "_c": color}
                if base_expr is not None:
                    bottom = base_expr.evaluate(context)
                    with contextlib.suppress(TypeError, ValueError):
                        bottom = float(bottom)
                        if math.isfinite(bottom) and bottom > 0:
                            props["_b"] = round(bottom, 3)
                if group_index >= 0:
                    group = feature.attributes()[group_index]
                    if group not in (None, "") and str(group) != "NULL":
                        props["_grp"] = str(group)
                for fld, value in zip(fields, feature.attributes()):
                    props[fld.name()] = _plain(value)
                features.append({"type": "Feature", "properties": props,
                                 "geometry": {"type": coords[0], "coordinates": coords[1]}})
                fids.append(int(feature.id()))
                if lspec.role == ROLE_BUILDINGS:
                    polygons[fid] = coords[1]
        finally:
            if renderer is not None:
                renderer.stopRender(render_ctx)
        if eval_errors:
            self.warnings.append(f"Layer '{layer.name()}': the height expression failed on {eval_errors} features "
                                 "(they use the default height).")
        if not features:
            self.warnings.append(f"Layer '{layer.name()}' has no features inside the scene area; skipped.")
            return None, None
        name = f"L{index}.geojson"
        with open(os.path.join(self.spec.out_dir, name), "w", encoding="utf-8") as handle:
            json.dump({"type": "FeatureCollection", "features": features}, handle, separators=(",", ":"))
        with open(os.path.join(self.spec.out_dir, f"L{index}.ids.json"), "w", encoding="utf-8") as handle:
            json.dump(fids, handle, separators=(",", ":"))
        entry = {
            "id": f"L{index}", "name": layer.name(), "file": name, "kind": kind, "role": lspec.role,
            "scenario": lspec.scenario, "count": len(features), "fields": field_meta,
            "heightExpr": height_expr.expression(), "baseExpr": lspec.base_expr or "",
            "defaultHeight": _default_height_value(lspec.role),
            "colorMode": lspec.color_mode, "defaultColor": default_color,
            "sourceLayerId": layer.id(), "sourceCrs": layer.crs().authid(),
        }
        return entry, polygons

    def _check_cancel(self) -> None:
        if self._is_cancelled():
            raise ExportCancelled("Export cancelled.")

    @staticmethod
    def _symbol_color(renderer, feature, ctx) -> str | None:
        with contextlib.suppress(Exception):
            symbols = renderer.symbolsForFeature(feature, ctx)
            if symbols:
                color = symbols[0].color()
                if color.isValid():
                    return color.name()
        return None

    @staticmethod
    def _local_coords(geom: QgsGeometry, kind: str, extent_geom: QgsGeometry, ox: float, oy: float):
        r = geo.round_coord
        if kind == "polygon":
            # Keep whole polygons whose centre lies in the scene, so buildings
            # are never cut in half at the edge.
            centre = geom.pointOnSurface()
            if centre.isEmpty() or not extent_geom.contains(centre):
                return None
            polys = geom.asMultiPolygon() if geom.isMultipart() else [geom.asPolygon()]
            out = []
            for poly in polys:
                rings = [[[r(p.x() - ox), r(p.y() - oy)] for p in ring] for ring in poly if len(ring) >= 4]
                if rings:
                    out.append(rings)
            return ("MultiPolygon", out) if out else None
        if kind == "line":
            clipped = geom.intersection(extent_geom)
            if clipped.isEmpty():
                return None
            lines = clipped.asMultiPolyline() if clipped.isMultipart() else [clipped.asPolyline()]
            out = [[[r(p.x() - ox), r(p.y() - oy)] for p in line] for line in lines if len(line) >= 2]
            return ("MultiLineString", out) if out else None
        points = geom.asMultiPoint() if geom.isMultipart() else [geom.asPoint()]
        out = [[r(p.x() - ox), r(p.y() - oy)] for p in points if extent_geom.contains(QgsGeometry.fromPointXY(p))]
        return ("MultiPoint", out) if out else None


def _machine_standard_offset() -> float | None:
    """This computer's standard (non-DST) UTC offset in hours."""
    with contextlib.suppress(Exception):
        from qgis.PyQt.QtCore import QDateTime, QTimeZone

        return QTimeZone.systemTimeZone().standardTimeOffset(QDateTime.currentDateTime()) / 3600.0
    return None


def _default_height_value(role: str) -> float:
    try:
        return float(DEFAULT_HEIGHT.get(role, "0"))
    except ValueError:
        return 0.0


def _plain(value):
    """A JSON-safe attribute value."""
    if value is None:
        return None
    with contextlib.suppress(Exception):
        if hasattr(value, "isNull") and value.isNull():
            return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    text = str(value)
    if text == "NULL":
        return None
    return text[:MAX_TEXT]


def _zonal_means(values, polygons: dict, grid_extent: QgsRectangle, cols: int, rows: int, origin) -> dict:
    """Mean raster value per polygon id. Cells whose centre falls inside a
    footprint count; footprints smaller than a cell take the value at their
    first vertex's cell."""
    from osgeo import gdal, ogr
    import numpy as np

    # GDAL 3.11 renamed the in-memory vector driver to MEM.
    driver = ogr.GetDriverByName("MEM") or ogr.GetDriverByName("Memory")
    source = driver.CreateDataSource("zones")
    layer = source.CreateLayer("zones", geom_type=ogr.wkbMultiPolygon)
    layer.CreateField(ogr.FieldDefn("zid", ogr.OFTInteger))
    ox, oy = origin
    for fid, polys in polygons.items():
        multi = ogr.Geometry(ogr.wkbMultiPolygon)
        for rings in polys:
            poly = ogr.Geometry(ogr.wkbPolygon)
            for ring_coords in rings:
                ring = ogr.Geometry(ogr.wkbLinearRing)
                for x, y in ring_coords:
                    ring.AddPoint_2D(x + ox, y + oy)
                poly.AddGeometry(ring)
            multi.AddGeometry(poly)
        feat = ogr.Feature(layer.GetLayerDefn())
        feat.SetField("zid", int(fid))
        feat.SetGeometry(multi)
        layer.CreateFeature(feat)
    cell = grid_extent.width() / cols
    target = gdal.GetDriverByName("MEM").Create("", cols, rows, 1, gdal.GDT_Int32)
    target.SetGeoTransform((grid_extent.xMinimum(), cell, 0, grid_extent.yMaximum(), 0, -cell))
    gdal.RasterizeLayer(target, [1], layer, options=["ATTRIBUTE=zid"])
    ids = target.GetRasterBand(1).ReadAsArray().astype(np.int64).ravel()
    vals = values.ravel().astype(np.float64)
    ok = (ids > 0) & np.isfinite(vals)
    size = max(polygons) + 1 if polygons else 1
    sums = np.bincount(ids[ok], weights=vals[ok], minlength=size)
    counts = np.bincount(ids[ok], minlength=size)
    out = {}
    for fid, polys in polygons.items():
        if counts[fid] > 0:
            out[fid] = sums[fid] / counts[fid]
            continue
        x, y = polys[0][0][0]
        col = int((x + ox - grid_extent.xMinimum()) / cell)
        row = int((grid_extent.yMaximum() - (y + oy)) / cell)
        if 0 <= col < cols and 0 <= row < rows and np.isfinite(values[row, col]):
            out[fid] = float(values[row, col])
    return out
