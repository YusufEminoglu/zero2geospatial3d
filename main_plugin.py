# -*- coding: utf-8 -*-
"""02 Geo3D Analyzer: toolbar icon that toggles the three-step dock."""
from __future__ import annotations

import os

from qgis.PyQt.QtCore import Qt
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction, QMessageBox, QToolBar

PLUGIN_TITLE = "02 Geo3D Analyzer"


class Geo3DAnalyzerPlugin:
    def __init__(self, iface):
        self.iface = iface
        self.plugin_dir = os.path.dirname(__file__)
        self.toolbar: QToolBar | None = None
        self.action: QAction | None = None
        self.quick_action: QAction | None = None
        self.dock = None

    def initGui(self) -> None:  # noqa: N802 (QGIS plugin API name)
        self.toolbar = QToolBar(PLUGIN_TITLE)
        self.toolbar.setObjectName("Zero2Geospatial3DToolbar")
        self.iface.addToolBar(self.toolbar)
        self.action = QAction(QIcon(os.path.join(self.plugin_dir, "icons", "icon.png")),
                              PLUGIN_TITLE, self.iface.mainWindow())
        self.action.setCheckable(True)
        self.action.setStatusTip("Open the 02 Geo3D Analyzer panel")
        self.action.triggered.connect(self.toggle_dock)
        self.toolbar.addAction(self.action)
        self.quick_action = QAction(QIcon(os.path.join(self.plugin_dir, "icons", "quick3d.png")),
                                    "Quick 3D of the selected raster (DEM)", self.iface.mainWindow())
        self.quick_action.setStatusTip("Show the selected raster layer as 3D terrain in the browser, with nothing else to set")
        self.quick_action.triggered.connect(self.quick_3d)
        self.toolbar.addAction(self.quick_action)

    def unload(self) -> None:
        if self.dock is not None:
            self.dock.shutdown()
            self.iface.removeDockWidget(self.dock)
            self.dock.setParent(None)
            self.dock.deleteLater()
            self.dock = None
        if self.toolbar is not None:
            self.iface.mainWindow().removeToolBar(self.toolbar)
            self.toolbar.setParent(None)
            self.toolbar.deleteLater()
            self.toolbar = None
        for name in ("action", "quick_action"):
            act = getattr(self, name)
            if act is not None:
                act.setParent(None)
                act.deleteLater()
                setattr(self, name, None)

    def quick_3d(self) -> None:
        from qgis.core import QgsRasterLayer

        layer = self.iface.activeLayer()
        if not isinstance(layer, QgsRasterLayer):
            QMessageBox.information(self.iface.mainWindow(), PLUGIN_TITLE,
                                    "Select a raster layer (a DEM) in the Layers panel first.")
            return
        if self.dock is None or not self.dock.isVisible():
            self.toggle_dock()
        if self.dock is not None:
            self.dock.quick_3d(layer)

    def toggle_dock(self) -> None:
        if self.dock is None:
            try:
                from .ui.dock import Geo3DDock

                self.dock = Geo3DDock(self.iface, self.plugin_dir, self.iface.mainWindow())
            except Exception as exc:  # noqa: BLE001 - show any construction failure
                QMessageBox.critical(self.iface.mainWindow(), PLUGIN_TITLE, f"The panel could not be created:\n{exc}")
                self.action.setChecked(False)
                return
            self.dock.visibilityChanged.connect(self.action.setChecked)
            self.iface.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self.dock)
            self.dock.show()
            self.dock.raise_()
            return
        self.dock.setVisible(not self.dock.isVisible())
        if self.dock.isVisible():
            self.dock.raise_()
