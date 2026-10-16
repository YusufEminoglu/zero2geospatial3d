# -*- coding: utf-8 -*-
"""QGIS's own 3D view: extruded, coloured building layers and DEM terrain.

Colours per class go through a rule-based 3D renderer (one Phong material
per class): data-defined material colours exist on QGIS 4 but are not
exposed to Python on QGIS 3.44, while rules work on both.
"""
from __future__ import annotations

import contextlib

from qgis.core import (
    Qgis,
    QgsAbstract3DSymbol,
    QgsCategorizedSymbolRenderer,
    QgsExpression,
    QgsGraduatedSymbolRenderer,
    QgsProject,
    QgsProperty,
    QgsRasterLayer,
    QgsVectorLayer,
)
from qgis.PyQt.QtGui import QColor

MAX_RULES = 40


def _three_d():
    from qgis._3d import QgsPhongMaterialSettings, QgsPolygon3DSymbol, QgsRuleBased3DRenderer

    return QgsPhongMaterialSettings, QgsPolygon3DSymbol, QgsRuleBased3DRenderer


def _quote_value(value) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def classes_from_renderer(layer: QgsVectorLayer) -> list:
    """(filter expression, QColor, label) per class of the layer's 2D style;
    a single entry for a single-symbol style."""
    renderer = layer.renderer()
    out = []
    if isinstance(renderer, QgsGraduatedSymbolRenderer):
        field = QgsExpression.quotedColumnRef(renderer.classAttribute())
        ranges = list(renderer.ranges())
        for k, rng in enumerate(ranges[:MAX_RULES]):
            upper = "<=" if k == len(ranges) - 1 else "<"
            out.append((f"{field} >= {rng.lowerValue()!r} AND {field} {upper} {rng.upperValue()!r}",
                        QColor(rng.symbol().color()), rng.label()))
    elif isinstance(renderer, QgsCategorizedSymbolRenderer):
        field = QgsExpression.quotedColumnRef(renderer.classAttribute())
        for cat in list(renderer.categories())[:MAX_RULES]:
            value = cat.value()
            if value in (None, "") or str(value) == "NULL":
                continue
            out.append((f"{field} = {_quote_value(value)}", QColor(cat.symbol().color()), cat.label()))
    elif renderer is not None and renderer.symbols(_render_context()):
        out.append(("", QColor(renderer.symbols(_render_context())[0].color()), layer.name()))
    return out


def fallback_from_renderer(layer: QgsVectorLayer):
    """(QColor, label) of a categorised style's "all other values" class, else None."""
    renderer = layer.renderer()
    if not isinstance(renderer, QgsCategorizedSymbolRenderer):
        return None
    for cat in renderer.categories():
        value = cat.value()
        if value is None or value == "" or str(value) == "NULL":
            return QColor(cat.symbol().color()), cat.label()
    return None


def _render_context():
    from qgis.core import QgsRenderContext

    return QgsRenderContext()


def _symbol(height_expr: str, color: QColor, default_height: float = 9.0):
    material_cls, symbol_cls, _ = _three_d()
    material = material_cls()
    material.setDiffuse(color)
    material.setAmbient(color.darker(220))
    material.setSpecular(QColor(30, 30, 30))
    symbol = symbol_cls()
    symbol.setMaterialSettings(material)
    symbol.setExtrusionHeight(default_height)
    if height_expr:
        props = symbol.dataDefinedProperties()
        props.setProperty(QgsAbstract3DSymbol.PropertyExtrusionHeight, QgsProperty.fromExpression(height_expr))
        symbol.setDataDefinedProperties(props)
    symbol.setAltitudeClamping(Qgis.AltitudeClamping.Terrain)
    return symbol


def style_layer_3d(layer: QgsVectorLayer, height_expr: str, classes: list | None = None,
                   fallback: QColor | None = None) -> bool:
    """Give a polygon layer a 3D renderer: extruded by ``height_expr``,
    coloured by ``classes`` (default: the layer's own 2D classes)."""
    _, _, rule_cls = _three_d()
    other_label = "Other"
    if classes is None:
        classes = classes_from_renderer(layer)
        if fallback is None:
            found = fallback_from_renderer(layer)
            if found:
                fallback, other_label = found
    grey = fallback or QColor("#cfcac2")
    root = rule_cls.Rule(None)
    if not classes:
        root.appendChild(rule_cls.Rule(_symbol(height_expr, grey), "", "Buildings"))
    for filter_expr, color, label in classes:
        root.appendChild(rule_cls.Rule(_symbol(height_expr, color), filter_expr, label))
    if classes and any(f for f, _, _ in classes):
        else_rule = rule_cls.Rule(_symbol(height_expr, grey), "", other_label)
        with contextlib.suppress(AttributeError):
            else_rule.setIsElse(True)
        root.appendChild(else_rule)
    layer.setRenderer3D(rule_cls(root))
    layer.trigger3DUpdate()
    return True


def set_terrain(dem: QgsRasterLayer, project: QgsProject | None = None) -> bool:
    """Use the DEM as the project's 3D terrain."""
    from qgis.core import QgsRasterDemTerrainProvider

    project = project or QgsProject.instance()
    provider = QgsRasterDemTerrainProvider()
    provider.setLayer(dem)
    project.elevationProperties().setTerrainProvider(provider)
    return True


def open_3d_view(iface, name: str = "02 Geo3D") -> bool:
    """Open a QGIS 3D map view when the interface offers it."""
    create = getattr(iface, "createNewMapCanvas3D", None)
    if create is None:
        return False
    with contextlib.suppress(Exception):
        return create(name) is not None
    return False
