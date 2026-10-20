# -*- coding: utf-8 -*-
"""02 Geo3D Analyzer: toolbar icon and menu actions that toggle the three-step dock and open manual."""
from __future__ import annotations

import os

from qgis.PyQt.QtCore import Qt, QUrl
from qgis.PyQt.QtGui import QDesktopServices, QIcon
from qgis.PyQt.QtWidgets import QAction, QMessageBox, QToolBar

from . import PLUGIN_VERSION

PLUGIN_TITLE = "02 Geo3D Analyzer"


class Geo3DAnalyzerPlugin:
    def __init__(self, iface):
        self.iface = iface
        self.plugin_dir = os.path.dirname(__file__)
        self.toolbar: QToolBar | None = None
        self.action: QAction | None = None
        self.quick_action: QAction | None = None
        self.manual_action: QAction | None = None
        self.about_action: QAction | None = None
        self.dock = None

    def initGui(self) -> None:  # noqa: N802 (QGIS plugin API name)
        menu_name = f"&{PLUGIN_TITLE}"
        self.toolbar = QToolBar(PLUGIN_TITLE)
        self.toolbar.setObjectName("Zero2Geospatial3DToolbar")
        self.iface.addToolBar(self.toolbar)

        icon = QIcon(os.path.join(self.plugin_dir, "icons", "icon.png"))
        self.action = QAction(icon, PLUGIN_TITLE, self.iface.mainWindow())
        self.action.setCheckable(True)
        self.action.setStatusTip("Open the 02 Geo3D Analyzer panel")
        self.action.triggered.connect(self.toggle_dock)
        self.toolbar.addAction(self.action)
        self.iface.addPluginToMenu(menu_name, self.action)

        self.quick_action = QAction(QIcon(os.path.join(self.plugin_dir, "icons", "quick3d.png")),
                                    "Quick 3D of the selected raster (DEM)", self.iface.mainWindow())
        self.quick_action.setStatusTip("Show the selected raster layer as 3D terrain in the browser, with nothing else to set")
        self.quick_action.triggered.connect(self.quick_3d)
        self.toolbar.addAction(self.quick_action)
        self.iface.addPluginToMenu(menu_name, self.quick_action)

        self.manual_action = QAction("Reference Manual (Online)...", self.iface.mainWindow())
        self.manual_action.setStatusTip("Open the online 02 Geo3D Analyzer Reference Manual (https://geophilo.com/zero2geospatial3d/)")
        self.manual_action.triggered.connect(self.open_manual)
        self.iface.addPluginToMenu(menu_name, self.manual_action)

        self.about_action = QAction(f"About {PLUGIN_TITLE}...", self.iface.mainWindow())
        self.about_action.setStatusTip(f"About {PLUGIN_TITLE}")
        self.about_action.triggered.connect(self.show_about)
        self.iface.addPluginToMenu(menu_name, self.about_action)

    def unload(self) -> None:
        menu_name = f"&{PLUGIN_TITLE}"
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
        for name in ("action", "quick_action", "manual_action", "about_action"):
            act = getattr(self, name)
            if act is not None:
                self.iface.removePluginMenu(menu_name, act)
                act.setParent(None)
                act.deleteLater()
                setattr(self, name, None)

    def open_manual(self) -> None:
        local_doc = os.path.join(self.plugin_dir, "docs", "index.html")
        if os.path.exists(local_doc):
            QDesktopServices.openUrl(QUrl.fromLocalFile(local_doc))
        else:
            QDesktopServices.openUrl(QUrl("https://geophilo.com/zero2geospatial3d/"))

    def show_about(self) -> None:
        icon = QIcon(os.path.join(self.plugin_dir, "icons", "icon.png"))
        msg = QMessageBox(self.iface.mainWindow())
        msg.setWindowTitle(f"About {PLUGIN_TITLE}")
        msg.setIconPixmap(icon.pixmap(64, 64))
        text = (
            f"<h3>{PLUGIN_TITLE} v{PLUGIN_VERSION}</h3>"
            "<p>3D viewer and environmental analyzer for terrain and buildings: sun &amp; shadow studies, "
            "Sky View Factor (SVF), facade daylight (VSC under CIE overcast sky), solar irradiation &amp; PV yield, "
            "viewsheds, pedestrian wind screening, UTCI thermal comfort, terrain metrics (slope, aspect, TPI, TRI, TWI), "
            "cross-sections, flooding, cut &amp; fill earthworks, and BRE 209 planning compliance checks.</p>"
            "<p><b>Author:</b> Yusuf Eminoğlu<br>"
            "<b>Online Reference Manual:</b> "
            "<a href='https://geophilo.com/zero2geospatial3d/'>https://geophilo.com/zero2geospatial3d/</a></p>"
            "<p>Runs locally via an embedded web server (127.0.0.1); no cloud dependencies or data uploads.</p>"
        )
        msg.setText(text)
        msg.setTextFormat(Qt.TextFormat.RichText)
        msg.setStandardButtons(QMessageBox.StandardButton.Ok)
        msg.exec()

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
