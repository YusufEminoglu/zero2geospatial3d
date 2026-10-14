# -*- coding: utf-8 -*-
"""QGIS 3 / QGIS 4 (PyQt5 / PyQt6) compatibility helpers.

``QgsField(name, QMetaType.Type.X)`` only exists from QGIS 3.38 and PyQt6 has
no ``QVariant.Type``; importing ``QMetaType`` proves nothing, so the overload
is probed once by constructing a field (docs/TRAPS.md 3.2b).
"""
from __future__ import annotations

import contextlib

from qgis.core import QgsField

_TYPES = None


def _types() -> dict:
    global _TYPES
    if _TYPES is not None:
        return _TYPES
    with contextlib.suppress(Exception):
        from qgis.PyQt.QtCore import QMetaType

        candidate = {"double": QMetaType.Type.Double, "int": QMetaType.Type.Int,
                     "string": QMetaType.Type.QString}
        QgsField("probe", candidate["double"])
        _TYPES = candidate
        return _TYPES
    from qgis.PyQt.QtCore import QVariant

    _TYPES = {"double": QVariant.Double, "int": QVariant.Int, "string": QVariant.String}
    return _TYPES


def make_field(name: str, kind: str = "double") -> QgsField:
    return QgsField(name, _types()[kind])


def enum_value(value) -> int:
    """Integer value of a PyQt5 int-enum or a PyQt6 Python enum."""
    return int(getattr(value, "value", value))
