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
    renderer = rule_cls(root)
    # LTR C++ NULL pointer crash defense: force renderer to bind to the layer
    with contextlib.suppress(Exception):
        renderer.setLayer(layer)
    layer.setRenderer3D(renderer)
    for method in ("trigger3DUpdate", "request3DUpdate", "triggerRepaint"):
        fn = getattr(layer, method, None)
        if fn is not None:
            with contextlib.suppress(Exception):
                fn()
    return True


def set_terrain(dem: QgsRasterLayer, project: QgsProject | None = None) -> bool:
    """Use the DEM as the project's 3D terrain."""
    if dem is None or not dem.isValid():
        return False
    try:
        from qgis.core import QgsRasterDemTerrainProvider

        project = project or QgsProject.instance()
        provider = QgsRasterDemTerrainProvider()
        provider.setLayer(dem)
        project.elevationProperties().setTerrainProvider(provider)
        return True
    except Exception:
        return False


def _object_identity(obj):
    try:
        class_name = obj.metaObject().className()
    except Exception:
        class_name = obj.__class__.__name__
    object_name = ""
    with contextlib.suppress(Exception):
        object_name = obj.objectName() or ""
    window_title = ""
    for getter in ("windowTitle", "title"):
        with contextlib.suppress(Exception):
            fn = getattr(obj, getter)
            window_title = fn() or ""
            if window_title:
                break
    return class_name, object_name, window_title


def _canvas_matches_name(canvas, name: str = "02 Geo3D") -> bool:
    class_name, object_name, window_title = _object_identity(canvas)
    target = (name or "").strip().lower()
    haystack = " ".join((class_name, object_name, window_title)).lower()
    return bool(target and target in haystack)


def _is_cpp_qgis_iface(iface) -> bool:
    mod = getattr(type(iface), "__module__", "") or ""
    return mod.startswith("qgis")


def _is_3d_canvas_object(obj) -> bool:
    with contextlib.suppress(Exception):
        from qgis._3d import Qgs3DMapCanvas
        if isinstance(obj, Qgs3DMapCanvas):
            return True
    class_name, object_name, window_title = _object_identity(obj)
    haystack = " ".join((class_name, object_name, window_title)).lower()
    return "3d" in haystack and "map" in haystack and "canvas" in haystack


def find_3d_map_canvases(iface) -> list:
    """Return active Qgs3DMapCanvas objects from widgets and QWindow instances."""
    if iface is None:
        return []
    with contextlib.suppress(Exception):
        import qgis._3d  # noqa: F401 - ensure SIP registers Qgs3DMapCanvas type
    candidates = []
    # Note: on C++ QgisInterface in QGIS 3.44 LTR, iface.mapCanvases3D() and
    # iface.createNewMapCanvas3D() wrap Qgs3DMapCanvas* inside _gui.pyd where
    # Qgs3DMapCanvas is an external SIP type, which can segfault in PyInit_sip.
    # Only call mapCanvases3D() on Python test doubles; in real QGIS, inspect
    # the Qt widget/window tree directly.
    if not _is_cpp_qgis_iface(iface):
        with contextlib.suppress(Exception):
            fn = getattr(iface, "mapCanvases3D", None)
            if fn is not None:
                candidates.extend(fn())
    with contextlib.suppress(Exception):
        win = iface.mainWindow() if hasattr(iface, "mainWindow") else None
        if win is not None:
            from qgis.PyQt.QtWidgets import QWidget
            candidates.extend(win.findChildren(QWidget))
    with contextlib.suppress(Exception):
        from qgis.PyQt.QtWidgets import QApplication
        app = QApplication.instance()
        if app is not None:
            candidates.extend(app.allWidgets())
            candidates.extend(app.allWindows())

    seen = set()
    canvases = []
    for obj in candidates:
        ident = id(obj)
        if ident in seen:
            continue
        seen.add(ident)
        if _is_3d_canvas_object(obj):
            canvases.append(obj)
    return canvases


def find_owned_3d_map_canvas(iface, name: str = "02 Geo3D"):
    """Find an existing 3D canvas that matches name."""
    for canvas in find_3d_map_canvases(iface):
        if _canvas_matches_name(canvas, name):
            return canvas
    return None


def raise_3d_view(canvas) -> bool:
    """Bring the 3D canvas and its parent dock/window to the front."""
    if canvas is None:
        return False
    from qgis.PyQt.QtWidgets import QDockWidget
    with contextlib.suppress(Exception):
        canvas.show()
        canvas.activateWindow()
        canvas.raise_()
    with contextlib.suppress(Exception):
        parent = canvas.parentWidget() if hasattr(canvas, "parentWidget") else None
        while parent is not None:
            if isinstance(parent, QDockWidget):
                parent.show()
                parent.activateWindow()
                parent.raise_()
                break
            parent = parent.parentWidget() if hasattr(parent, "parentWidget") else None
    return True


def open_3d_view(iface, name: str = "02 Geo3D") -> bool:
    """Open or raise a QGIS 3D map view defensively.

    Reuses an existing canvas with this name if one is already open. If not,
    triggers QGIS's built-in View > 3D Map Views > New 3D Map View action
    via the Qt event loop so _gui.pyd never wraps a raw Qgs3DMapCanvas* pointer
    across module boundaries in PyInit_sip.
    """
    if iface is None:
        return False
    with contextlib.suppress(Exception):
        import qgis._3d  # noqa: F401

    # 1. Reuse existing canvas if present
    existing = find_owned_3d_map_canvas(iface, name)
    if existing is not None:
        return raise_3d_view(existing)

    win = None
    with contextlib.suppress(Exception):
        win = iface.mainWindow() if hasattr(iface, "mainWindow") else None

    # 2. Trigger the built-in QAction so QGIS C++ manages the 3D canvas lifecycle
    target_action = None
    if win is not None:
        try:
            from qgis.PyQt.QtGui import QAction
        except ImportError:
            from qgis.PyQt.QtWidgets import QAction

        for obj_name in ("mActionNew3DMapCanvas", "mActionNew3DMapView", "mActionNew3DMap"):
            act = win.findChild(QAction, obj_name)
            if act is not None:
                target_action = act
                break

        if target_action is None and hasattr(iface, "viewMenu"):
            with contextlib.suppress(Exception):
                view_menu = iface.viewMenu()
                if view_menu is not None:
                    for menu_act in view_menu.actions():
                        sub = menu_act.menu()
                        if sub is not None:
                            for sub_act in sub.actions():
                                oname = (sub_act.objectName() or "").lower()
                                txt = (sub_act.text() or "").lower()
                                if "3d" in oname or ("3d" in txt and ("new" in txt or "yeni" in txt)):
                                    target_action = sub_act
                                    break
                        if target_action is not None:
                            break

    if target_action is not None:
        with contextlib.suppress(Exception):
            from qgis.PyQt.QtCore import QTimer

            def _trigger_and_label():
                with contextlib.suppress(Exception):
                    target_action.trigger()

                def _label_new_canvas():
                    canvases = find_3d_map_canvases(iface)
                    if canvases:
                        target_canvas = canvases[-1]
                        for setter in ("setObjectName", "setWindowTitle", "setTitle"):
                            fn = getattr(target_canvas, setter, None)
                            if fn is not None:
                                with contextlib.suppress(Exception):
                                    fn(name)

                QTimer.singleShot(500, _label_new_canvas)

            QTimer.singleShot(0, _trigger_and_label)
            return True

    # 3. Direct API fallback ONLY for non-C++ test doubles (calling
    # createNewMapCanvas3D on C++ QgisInterface in QGIS 3.44 LTR segfaults in PyInit_sip).
    if _is_cpp_qgis_iface(iface):
        return False
    create = getattr(iface, "createNewMapCanvas3D", None)
    if create is None:
        return False
    try:
        canvas = create(name)
        if canvas is not None:
            with contextlib.suppress(Exception):
                canvas.setObjectName(name)
            return True
    except TypeError:
        with contextlib.suppress(Exception):
            return create(name, None) is not None
    except Exception:
        return False
    return False

