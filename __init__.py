# -*- coding: utf-8 -*-
"""02 Geo3D Analyzer: a 3D viewer and analyzer for terrain and extruded layers."""

PLUGIN_VERSION = "1.0.3"


def classFactory(iface):  # noqa: N802 (QGIS plugin API name)
    from .main_plugin import Geo3DAnalyzerPlugin

    return Geo3DAnalyzerPlugin(iface)
