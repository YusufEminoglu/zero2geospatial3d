# -*- coding: utf-8 -*-
"""The three-step panel: 1 Terrain, 2 Objects, 3 Open in 3D."""
from __future__ import annotations

import contextlib
import os
import re
import traceback

from qgis.PyQt.QtCore import QSize, Qt, QTimer, QUrl
from qgis.PyQt.QtGui import QDesktopServices, QIcon
from qgis.PyQt.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDockWidget,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)
from qgis.core import (
    QgsApplication,
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsMapLayerProxyModel,
    QgsProject,
    QgsRasterLayer,
    QgsRectangle,
    QgsVectorLayer,
)
from qgis.gui import QgsFieldExpressionWidget, QgsFileWidget, QgsMapLayerComboBox

from .. import PLUGIN_VERSION
from ..core import scene_export as sx
from ..core.server import ViewerServer, web_root_for
from .widgets import PANEL_QSS, Fold, Header, StepCard, hint, muted, theme_icon

HELP_URL = "https://github.com/YusufEminoglu/zero2geospatial3d/blob/main/docs/index.html"

AREA_DEM, AREA_VIEW, AREA_OBJECTS = range(3)
DETAIL_CHOICES = [("1024 cells (light)", 1024), ("2048 cells", 2048), ("4096 cells (large, fine DEMs)", 4096)]
GRID_CHOICES = [("Automatic (DEM resolution)", None), ("1 m", 1.0), ("2 m", 2.0),
                ("5 m", 5.0), ("10 m", 10.0), ("25 m", 25.0)]

_HEIGHT_FIELDS = ("height_m", "height", "yukseklik", "yükseklik", "bina_yuk", "bina_yukseklik", "h", "hgt", "elev_top")
_FLOOR_FIELDS = ("floors", "levels", "building_levels", "num_floors", "kat", "kat_sayisi", "katsayisi",
                 "kat_adedi", "kat_say", "storeys", "stories")
_NAME_HINTS = {
    sx.ROLE_BUILDINGS: re.compile(r"build|bina|yap[iı]|house|konut|footprint|blok", re.I),
    sx.ROLE_TREES: re.compile(r"tree|a[gğ]a[cç]", re.I),
    sx.ROLE_WALLS: re.compile(r"wall|duvar|fence|[cç]it|barrier", re.I),
    sx.ROLE_SECTIONS: re.compile(r"section|kesit|profil", re.I),
    sx.ROLE_PLATFORMS: re.compile(r"platform|cut|fill|kaz[iı]|dolgu|grading", re.I),
}


def guess_role(layer: QgsVectorLayer) -> tuple[str, bool]:
    """(role, checked) from the layer's geometry, name and fields."""
    kind = sx.geometry_kind(layer)
    roles = sx.ROLES_BY_KIND.get(kind, [])
    if not roles:
        return "", False
    names = {f.name().lower() for f in layer.fields()}
    for role in roles:
        hint = _NAME_HINTS.get(role)
        if hint and hint.search(layer.name()):
            return role, True
    if kind == "polygon" and names & set(_HEIGHT_FIELDS + _FLOOR_FIELDS):
        return sx.ROLE_BUILDINGS, True
    return roles[0], False


def guess_base_expression(layer: QgsVectorLayer) -> str:
    """A bottom-height field (OSM min_height and the like), or empty."""
    by_lower = {f.name().lower(): f.name() for f in layer.fields() if f.isNumeric()}
    for name in ("min_height_m", "min_height", "base_height", "bottom_m"):
        if name in by_lower:
            return f'"{by_lower[name]}"'
    return ""


def guess_height_expression(layer: QgsVectorLayer, role: str) -> str:
    by_lower = {f.name().lower(): f.name() for f in layer.fields() if f.isNumeric()}
    for name in _HEIGHT_FIELDS:
        if name in by_lower:
            return f'"{by_lower[name]}"'
    if role in (sx.ROLE_BUILDINGS, sx.ROLE_WALLS):
        for name in _FLOOR_FIELDS:
            if name in by_lower:
                return f'"{by_lower[name]}" * 3'
    return sx.DEFAULT_HEIGHT.get(role, "0")


class LayerRow(QFrame):
    """One vector layer: include it, its role, height and colour. Unticked
    layers take one line; ticking a layer opens its settings."""

    KIND_ICONS = {"polygon": "/mIconPolygonLayer.svg", "line": "/mIconLineLayer.svg", "point": "/mIconPointLayer.svg"}

    def __init__(self, layer: QgsVectorLayer, parent=None):
        super().__init__(parent)
        self.layer = layer
        self.setObjectName("g3dRow")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 5, 8, 5)
        outer.setSpacing(4)
        role, checked = guess_role(layer)
        head = QHBoxLayout()
        head.setSpacing(6)
        kind_icon = QLabel()
        kind_icon.setPixmap(theme_icon(self.KIND_ICONS.get(sx.geometry_kind(layer), "/mIconVector.svg")).pixmap(QSize(16, 16)))
        head.addWidget(kind_icon)
        self.check = QCheckBox(layer.name())
        self.check.setChecked(checked)
        self.check.setToolTip(f"{layer.name()} — {layer.featureCount()} features, {layer.crs().authid()}")
        head.addWidget(self.check, 1)
        head.addWidget(muted(QLabel(f"{layer.featureCount():,}".replace(",", " "))))
        outer.addLayout(head)

        self.details = QWidget()
        grid = QGridLayout(self.details)
        grid.setContentsMargins(22, 0, 0, 2)
        grid.setHorizontalSpacing(6)
        grid.setVerticalSpacing(3)
        self.role = QComboBox()
        for key in sx.ROLES_BY_KIND.get(sx.geometry_kind(layer), []):
            self.role.addItem(sx.ROLE_LABELS[key], key)
        self.role.setCurrentIndex(max(0, self.role.findData(role)))
        self.role.setToolTip("How the layer is drawn and analysed in 3D")
        grid.addWidget(muted(QLabel("Role")), 0, 0)
        grid.addWidget(self.role, 0, 1, 1, 2)

        grid.addWidget(muted(QLabel("Height")), 1, 0)
        self.height = QgsFieldExpressionWidget()
        self.height.setLayer(layer)
        self.height.setExpression(guess_height_expression(layer, role))
        self.height.setToolTip("Height in metres above the ground, e.g. \"floors\" * 3.2")
        grid.addWidget(self.height, 1, 1, 1, 2)

        self.base_label = muted(QLabel("Bottom"))
        self.base = QgsFieldExpressionWidget()
        self.base.setLayer(layer)
        self.base.setExpression(guess_base_expression(layer))
        self.base.setToolTip("Optional: where the extrusion starts above the ground, e.g. \"min_height\" for a "
                             "tower part standing on a podium. Leave empty to start at the ground.")
        grid.addWidget(self.base_label, 2, 0)
        grid.addWidget(self.base, 2, 1, 1, 2)

        grid.addWidget(muted(QLabel("Colour")), 3, 0)
        self.color = QComboBox()
        self.color.addItem("QGIS style", "qgis")
        self.color.addItem("Single colour", "single")
        self.color.setToolTip("Colours come from the layer's QGIS symbology; you can recolour by any field in the viewer")
        grid.addWidget(self.color, 3, 1)
        self.scenario = QComboBox()
        self.scenario.addItem("Existing", "both")
        self.scenario.addItem("Scenario A", "A")
        self.scenario.addItem("Scenario B", "B")
        self.scenario.setToolTip("Existing buildings appear in every scenario; A/B layers are compared in the viewer")
        grid.addWidget(self.scenario, 3, 2)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(2, 1)
        outer.addWidget(self.details)
        self.role.currentIndexChanged.connect(self._role_changed)
        self.check.toggled.connect(self._checked)
        self._role_changed()
        self._checked(self.check.isChecked())

    def _checked(self, on: bool) -> None:
        self.details.setVisible(on)
        self.setProperty("on", "true" if on else "false")
        self.style().unpolish(self)
        self.style().polish(self)

    def _role_changed(self) -> None:
        role = self.role.currentData()
        self.scenario.setVisible(role == sx.ROLE_BUILDINGS)
        self.base.setVisible(role == sx.ROLE_BUILDINGS)
        self.base_label.setVisible(role == sx.ROLE_BUILDINGS)
        uses_height = role in (sx.ROLE_BUILDINGS, sx.ROLE_WALLS, sx.ROLE_TREES, sx.ROLE_POLES, sx.ROLE_PLATFORMS)
        self.height.setEnabled(uses_height)
        if role == sx.ROLE_PLATFORMS:
            self.height.setToolTip("Design elevation of the platform (absolute, metres above sea level)")
        else:
            self.height.setToolTip("Height in metres above the ground, e.g. \"floors\" * 3.2")

    def spec(self) -> sx.LayerSpec:
        is_building = self.role.currentData() == sx.ROLE_BUILDINGS
        return sx.LayerSpec(layer=self.layer, role=self.role.currentData(),
                            height_expr=self.height.expression().strip(),
                            color_mode=self.color.currentData(),
                            # By role, not isVisible(): that is False whenever the panel is hidden.
                            scenario=self.scenario.currentData() if is_building else "both",
                            base_expr=self.base.expression().strip() if is_building else "")


class Geo3DDock(QDockWidget):
    def __init__(self, iface, plugin_dir: str, parent=None):
        super().__init__("02 Geo3D Analyzer", parent)
        self.setObjectName("Zero2Geospatial3DDock")
        self.iface = iface
        self.plugin_dir = plugin_dir
        self.server = ViewerServer(web_root_for(plugin_dir), version=PLUGIN_VERSION)
        self.rows: list[LayerRow] = []
        self.scene_dir = ""
        self.writer = None
        self._cancel = False
        self._busy = False
        self._watched: list = []
        self._build()
        self.refresh_layers()
        self.timer = QTimer(self)
        self.timer.setInterval(400)
        self.timer.timeout.connect(self._poll_viewer)
        project = QgsProject.instance()
        project.layersAdded.connect(self._schedule_refresh)
        project.layersRemoved.connect(self._schedule_refresh)

    def _open_manual(self) -> None:
        local_doc = os.path.join(self.plugin_dir, "docs", "index.html")
        if os.path.exists(local_doc):
            QDesktopServices.openUrl(QUrl.fromLocalFile(local_doc))
        else:
            QDesktopServices.openUrl(QUrl(HELP_URL))

    # ------------------------------------------------------------ UI
    def _build(self) -> None:
        body = QWidget()
        body.setObjectName("g3dPanel")
        body.setStyleSheet(PANEL_QSS)
        root = QVBoxLayout(body)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(8)
        root.addWidget(Header(os.path.join(self.plugin_dir, "icons", "icon.png"), PLUGIN_VERSION,
                              self._open_manual))

        # 1 Terrain
        c1 = StepCard(1, "Terrain", "A DEM gives the ground its shape; leave it empty for flat ground.")
        form1 = QGridLayout()
        form1.setHorizontalSpacing(8)
        self.dem = QgsMapLayerComboBox()
        self.dem.setFilters(QgsMapLayerProxyModel.Filter.RasterLayer)
        self.dem.setAllowEmptyLayer(True)
        with contextlib.suppress(TypeError):
            self.dem.setAllowEmptyLayer(True, "Flat ground (no DEM)")
        self.dem.setToolTip("Elevation raster (DEM/DSM). Leave empty for flat ground.")
        form1.addWidget(muted(QLabel("DEM")), 0, 0)
        form1.addWidget(self.dem, 0, 1)
        self.area = QComboBox()
        self.area.addItem("DEM extent", AREA_DEM)
        self.area.addItem("Current map view", AREA_VIEW)
        self.area.addItem("Extent of the selected objects", AREA_OBJECTS)
        self.area.setToolTip("The scene covers this area; objects outside it are left out")
        form1.addWidget(muted(QLabel("Area")), 1, 0)
        form1.addWidget(self.area, 1, 1)
        form1.setColumnStretch(1, 1)
        c1.body.addLayout(form1)
        self.quick_button = QPushButton("Quick 3D of this DEM")
        self.quick_button.setIcon(QIcon(os.path.join(self.plugin_dir, "icons", "quick3d.png")))
        self.quick_button.setToolTip("Open the DEM alone in 3D, over the current map view (or the whole DEM), "
                                     "without exporting any layer")
        self.quick_button.clicked.connect(lambda: self.quick_3d())
        c1.body.addWidget(self.quick_button)
        more1 = QWidget()
        form_more1 = QGridLayout(more1)
        form_more1.setContentsMargins(0, 0, 0, 0)
        form_more1.setHorizontalSpacing(8)
        self.cell = QComboBox()
        for label, value in GRID_CHOICES:
            self.cell.addItem(label, value)
        self.cell.setToolTip("Terrain grid resolution. Automatic uses the DEM's own resolution.")
        form_more1.addWidget(muted(QLabel("Grid")), 0, 0)
        form_more1.addWidget(self.cell, 0, 1)
        self.detail = QComboBox()
        for label, value in DETAIL_CHOICES:
            self.detail.addItem(label, value)
        self.detail.setCurrentIndex(1)
        self.detail.setToolTip("Most cells on the longest side. Above 1024 the viewer draws the terrain in tiles "
                               "whose density follows the camera, so large fine DEMs stay smooth.")
        form_more1.addWidget(muted(QLabel("Detail limit")), 1, 0)
        form_more1.addWidget(self.detail, 1, 1)
        form_more1.setColumnStretch(1, 1)
        c1.body.addWidget(Fold("More options", more1))
        root.addWidget(c1)

        # 2 Objects
        c2 = StepCard(2, "Objects", "Tick the layers to show in 3D; a ticked layer shows its role, height and colour.")
        self.rows_box = QVBoxLayout()
        self.rows_box.setSpacing(4)
        c2.body.addLayout(self.rows_box)
        self.empty_label = hint("No vector layers in the project yet. Add buildings, trees or lines, "
                                "or download OpenStreetMap buildings below.")
        c2.body.addWidget(self.empty_label)
        buttons = QHBoxLayout()
        refresh = QToolButton()
        refresh.setIcon(theme_icon("/mActionRefresh.svg"))
        refresh.setToolTip("Refresh the list of layers")
        refresh.setAutoRaise(True)
        refresh.clicked.connect(self.refresh_layers)
        self.osm_button = QPushButton("Download OSM buildings && trees")
        self.osm_button.setIcon(theme_icon("/mActionAddLayer.svg"))
        self.osm_button.setToolTip("Buildings (with heights from OSM tags) and trees for the scene area, "
                                   "from the OpenStreetMap Overpass API")
        self.osm_button.clicked.connect(self.download_osm)
        buttons.addWidget(self.osm_button, 1)
        buttons.addWidget(refresh)
        c2.body.addLayout(buttons)

        climate_box = QWidget()
        lc = QVBoxLayout(climate_box)
        lc.setContentsMargins(0, 0, 0, 0)
        lc.setSpacing(4)
        lc.addWidget(hint("Rasters to drape on the ground and average per building, e.g. land surface "
                          "temperature or NDVI."))
        self.climate = QListWidget()
        self.climate.setMaximumHeight(80)
        self.climate.setToolTip("e.g. land surface temperature, air temperature, NDVI")
        lc.addWidget(self.climate)
        epw_row = QHBoxLayout()
        self.epw = QgsFileWidget()
        self.epw.setFilter("EnergyPlus weather (*.epw)")
        self.epw.setToolTip("Hourly weather for annual radiation, wind and comfort analyses")
        nearest = QPushButton("Nearest station…")
        nearest.setToolTip("Download the TMYx weather file of the nearest station from climate.onebuilding.org")
        nearest.clicked.connect(self.pick_station)
        epw_row.addWidget(muted(QLabel("Weather")))
        epw_row.addWidget(self.epw, 1)
        epw_row.addWidget(nearest)
        lc.addLayout(epw_row)
        c2.body.addWidget(Fold("Climate data (optional)", climate_box))
        root.addWidget(c2)

        # 3 Open in 3D
        c3 = StepCard(3, "Open in 3D", "The scene opens in your browser; results come back here as layers.")
        self.open_button = QPushButton("Open in 3D")
        self.open_button.setObjectName("g3dPrimary")
        self.open_button.setIcon(QIcon(os.path.join(self.plugin_dir, "icons", "icon.png")))
        self.open_button.setIconSize(QSize(22, 22))
        self.open_button.setMinimumHeight(40)
        self.open_button.clicked.connect(self.open_in_3d)
        c3.body.addWidget(self.open_button)
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setVisible(False)
        c3.body.addWidget(self.progress)
        actions = QHBoxLayout()
        actions.setSpacing(4)
        self.reopen = QPushButton("Viewer")
        self.reopen.setIcon(theme_icon("/mActionShowAllLayers.svg"))
        self.reopen.setToolTip("Show the viewer of the last scene again")
        self.reopen.clicked.connect(self.show_viewer)
        self.reopen.setEnabled(False)
        self.qgis3d_button = QPushButton("QGIS 3D")
        self.qgis3d_button.setIcon(theme_icon("/mActionNew3DMap.svg"))
        self.qgis3d_button.setToolTip("Use the DEM as the project's 3D terrain, extrude the ticked building layers "
                                      "with their height expressions and colours, and open a QGIS 3D map view")
        self.qgis3d_button.clicked.connect(self.setup_qgis_3d)
        open_folder = QPushButton("Folder")
        open_folder.setIcon(theme_icon("/mIconFolderOpen.svg"))
        open_folder.setToolTip("Open the scene folder (scene files and analysis results)")
        open_folder.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(self.folder.filePath())))
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.clicked.connect(self._request_cancel)
        self.cancel_button.setVisible(False)
        for w in (self.reopen, self.qgis3d_button, open_folder, self.cancel_button):
            actions.addWidget(w)
        c3.body.addLayout(actions)
        more3 = QWidget()
        folder_row = QHBoxLayout(more3)
        folder_row.setContentsMargins(0, 0, 0, 0)
        self.folder = QgsFileWidget()
        self.folder.setStorageMode(QgsFileWidget.StorageMode.GetDirectory)
        self.folder.setFilePath(self._default_scene_dir())
        self.folder.setToolTip("Scene files and analysis results are written here")
        folder_row.addWidget(muted(QLabel("Folder")))
        folder_row.addWidget(self.folder, 1)
        c3.body.addWidget(Fold("More options", more3))
        root.addWidget(c3)

        # Activity
        self.log = QListWidget()
        self.log.setMinimumHeight(90)
        self.log.setWordWrap(True)
        self.log.setFrameShape(QFrame.Shape.NoFrame)
        log_box = QWidget()
        ll = QVBoxLayout(log_box)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(self.log)
        root.addWidget(Fold("Messages and results", log_box, opened=True))
        root.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(body)
        self.setWidget(scroll)
        self.setMinimumWidth(320)
        body.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Minimum)

    # ------------------------------------------------------------ layer list
    def _schedule_refresh(self, *args) -> None:
        if not self._busy:
            QTimer.singleShot(200, self.refresh_layers)

    def refresh_layers(self) -> None:
        previous = {row.layer.id(): row.spec() for row in self.rows if not _deleted(row.layer)}
        for row in self.rows:
            row.setParent(None)
            row.deleteLater()
        self.rows = []
        dem_id = self.dem.currentLayer().id() if self.dem.currentLayer() else ""
        for layer in QgsProject.instance().mapLayers().values():
            if isinstance(layer, QgsVectorLayer) and layer.isSpatial() and sx.geometry_kind(layer):
                row = LayerRow(layer)
                old = previous.get(layer.id())
                if old is not None:
                    row.check.setChecked(True)
                    row.role.setCurrentIndex(max(0, row.role.findData(old.role)))
                    row.height.setExpression(old.height_expr)
                    row.base.setExpression(old.base_expr)
                    row.color.setCurrentIndex(max(0, row.color.findData(old.color_mode)))
                    row.scenario.setCurrentIndex(max(0, row.scenario.findData(old.scenario)))
                self.rows.append(row)
                self.rows_box.addWidget(row)
        self.empty_label.setVisible(not self.rows)
        checked = {self.climate.item(i).data(Qt.ItemDataRole.UserRole)
                   for i in range(self.climate.count())
                   if self.climate.item(i).checkState() == Qt.CheckState.Checked}
        self.climate.clear()
        for layer in QgsProject.instance().mapLayers().values():
            if isinstance(layer, QgsRasterLayer) and layer.id() != dem_id:
                item = QListWidgetItem(layer.name())
                item.setData(Qt.ItemDataRole.UserRole, layer.id())
                item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                item.setCheckState(Qt.CheckState.Checked if layer.id() in checked else Qt.CheckState.Unchecked)
                self.climate.addItem(item)

    # ------------------------------------------------------------ helpers
    def _default_scene_dir(self) -> str:
        project = QgsProject.instance()
        stored, ok = project.readEntry("zero2geospatial3d", "scene_dir", "")
        if ok and stored:
            return stored
        if project.fileName():
            base = os.path.splitext(os.path.basename(project.fileName()))[0]
            return os.path.join(os.path.dirname(project.fileName()), f"{base}_geo3d")
        return os.path.join(QgsApplication.qgisSettingsDirPath(), "zero2geospatial3d", "scene")

    def message(self, text: str, error: bool = False) -> None:
        item = QListWidgetItem(text)
        if error:
            item.setForeground(Qt.GlobalColor.darkRed)
        self.log.insertItem(0, item)
        while self.log.count() > 80:
            self.log.takeItem(self.log.count() - 1)

    def _selected_specs(self) -> list:
        return [row.spec() for row in self.rows if row.check.isChecked() and not _deleted(row.layer)]

    def _scene_extent(self, specs) -> tuple[QgsRectangle, QgsCoordinateReferenceSystem]:
        mode = self.area.currentData()
        dem = self.dem.currentLayer()
        canvas = self.iface.mapCanvas()
        if mode == AREA_VIEW or (mode == AREA_DEM and dem is None and not specs):
            return QgsRectangle(canvas.extent()), canvas.mapSettings().destinationCrs()
        if mode == AREA_DEM and dem is not None:
            return QgsRectangle(dem.extent()), dem.crs()
        crs = canvas.mapSettings().destinationCrs()
        rect = QgsRectangle()
        rect.setMinimal()
        for spec in specs:
            xform = QgsCoordinateTransform(spec.layer.crs(), crs, QgsProject.instance())
            rect.combineExtentWith(xform.transformBoundingBox(spec.layer.extent()))
        if rect.isEmpty():
            return QgsRectangle(canvas.extent()), crs
        return rect, crs

    def _progress(self, pct, msg) -> None:
        if pct is not None:
            self.progress.setValue(int(pct))
        self.progress.setFormat(f"%p%  {msg}")
        QApplication.processEvents()

    def _request_cancel(self) -> None:
        self._cancel = True

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        self.open_button.setEnabled(not busy)
        self.quick_button.setEnabled(not busy)
        self.osm_button.setEnabled(not busy)
        self.progress.setVisible(busy)
        self.cancel_button.setVisible(busy)
        if busy:
            self._cancel = False
            self.progress.setValue(0)

    # ------------------------------------------------------------ actions
    def open_in_3d(self) -> None:
        specs = self._selected_specs()
        dem = self.dem.currentLayer()
        if dem is None and not specs:
            QMessageBox.information(self, "02 Geo3D Analyzer", "Pick a DEM or tick at least one layer first.")
            return
        out_dir = self.folder.filePath().strip() or self._default_scene_dir()
        extent, extent_crs = self._scene_extent(specs)
        climate = []
        for i in range(self.climate.count()):
            item = self.climate.item(i)
            if item.checkState() == Qt.CheckState.Checked:
                layer = QgsProject.instance().mapLayer(item.data(Qt.ItemDataRole.UserRole))
                if layer is not None:
                    climate.append(layer)
        spec = sx.ExportSpec(out_dir=out_dir, extent=extent, extent_crs=extent_crs, dem=dem,
                             cell_size=self.cell.currentData(), layers=specs, climate_rasters=climate,
                             epw_path=self.epw.filePath().strip(), max_cells=self.detail.currentData(),
                             title=os.path.splitext(os.path.basename(QgsProject.instance().fileName()))[0] or "Scene")
        self._set_busy(True)
        try:
            result = sx.SceneExporter(spec, self._progress, lambda: self._cancel).run()
        except sx.ExportCancelled:
            self.message("Export cancelled.")
            return
        except sx.ExportError as exc:
            self.message(str(exc), error=True)
            QMessageBox.warning(self, "02 Geo3D Analyzer", str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - report anything with its trace
            self.message(f"Export failed: {exc}", error=True)
            QgsApplication.messageLog().logMessage(traceback.format_exc(), "02 Geo3D Analyzer")
            QMessageBox.critical(self, "02 Geo3D Analyzer", f"Export failed:\n{exc}")
            return
        finally:
            self._set_busy(False)
        QgsProject.instance().writeEntry("zero2geospatial3d", "scene_dir", out_dir)
        for warning in result.warnings:
            self.message(warning)
        counts = ", ".join(f"{e['name']} {e['count']}" for e in result.manifest["layers"]) or "terrain only"
        self.message(f"Scene written: {counts}.")
        self._activate_scene(out_dir)
        self.show_viewer()

    def _activate_scene(self, scene_dir: str) -> None:
        from ..core.results import ResultWriter

        self.scene_dir = scene_dir
        self.writer = ResultWriter(scene_dir, log=lambda m: self.message(m, error=True))
        self.server.set_scene_dir(scene_dir)
        try:
            self.server.start()
        except OSError as exc:
            self.message(str(exc), error=True)
            return
        self.reopen.setEnabled(True)
        self.timer.start()
        self._watch_selection()

    def quick_3d(self, raster=None) -> None:
        """The DEM alone in 3D: no layers, the map view's part of the DEM (or all of it)."""
        dem = raster or self.dem.currentLayer()
        if dem is None:
            active = self.iface.activeLayer()
            dem = active if isinstance(active, QgsRasterLayer) else None
        if dem is None:
            QMessageBox.information(self, "02 Geo3D Analyzer", "Pick a DEM in step 1, or select a raster layer in the Layers panel.")
            return
        if self.dem.currentLayer() is not dem:
            self.dem.setLayer(dem)
        canvas = self.iface.mapCanvas()
        view = QgsCoordinateTransform(canvas.mapSettings().destinationCrs(), dem.crs(),
                                      QgsProject.instance()).transformBoundingBox(canvas.extent())
        extent = QgsRectangle(dem.extent())
        if view.intersects(extent) and view.area() < extent.area():
            extent = view.intersect(extent)
        out_dir = os.path.join(self.folder.filePath().strip() or self._default_scene_dir(), "quick")
        spec = sx.ExportSpec(out_dir=out_dir, extent=extent, extent_crs=dem.crs(), dem=dem, layers=[],
                             cell_size=self.cell.currentData(), max_cells=self.detail.currentData(),
                             title=f"{dem.name()} (quick 3D)")
        self._set_busy(True)
        try:
            result = sx.SceneExporter(spec, self._progress, lambda: self._cancel).run()
        except sx.ExportCancelled:
            self.message("Quick 3D cancelled.")
            return
        except sx.ExportError as exc:
            self.message(str(exc), error=True)
            QMessageBox.warning(self, "02 Geo3D Analyzer", str(exc))
            return
        finally:
            self._set_busy(False)
        g = result.manifest["grid"]
        self.message(f"Quick 3D: {dem.name()}, {g['cols']} x {g['rows']} cells of {g['cell']:.1f} m.")
        self._activate_scene(out_dir)
        self.show_viewer()

    def setup_qgis_3d(self) -> None:
        """QGIS's own 3D view: DEM terrain plus extruded, coloured building layers."""
        from ..core import qgis3d

        done = []
        dem = self.dem.currentLayer()
        if dem is not None:
            qgis3d.set_terrain(dem)
            done.append(f"terrain from {dem.name()}")
        for row in self.rows:
            spec = row.spec()
            if not row.check.isChecked() or spec.role != sx.ROLE_BUILDINGS:
                continue
            try:
                qgis3d.style_layer_3d(row.layer, spec.height_expr or sx.DEFAULT_HEIGHT[sx.ROLE_BUILDINGS])
                done.append(row.layer.name())
            except Exception as exc:  # noqa: BLE001
                self.message(f"No 3D style for '{row.layer.name()}': {exc}", error=True)
        if not done:
            self.message("Pick a DEM or tick a building layer first.", error=True)
            return
        opened = qgis3d.open_3d_view(self.iface)
        self.message("QGIS 3D: " + ", ".join(done) + (". A 3D map view is open." if opened else
                     ". Open it with View > 3D Map Views > New 3D Map View."))

    def show_viewer(self) -> None:
        url = self.server.viewer_url()
        if url:
            QDesktopServices.openUrl(QUrl(url))
            self.message(f"Viewer: {url}")

    def pick_station(self) -> None:
        from ..core import epw

        extent, crs = self._scene_extent(self._selected_specs())
        wgs = QgsCoordinateReferenceSystem("EPSG:4326")
        centre = QgsCoordinateTransform(crs, wgs, QgsProject.instance()).transform(extent.center())
        try:
            stations = epw.nearest_stations(centre.y(), centre.x(), 8)
        except epw.EpwError as exc:
            self.message(str(exc), error=True)
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("Nearest weather stations")
        lay = QVBoxLayout(dialog)
        lay.addWidget(QLabel(f"TMYx files from climate.onebuilding.org near {centre.y():.4f}, {centre.x():.4f}"))
        listing = QListWidget()
        for st in stations:
            item = QListWidgetItem(f"{st['station']}  —  {st['distance_km']} km, "
                                   f"{st['elevation'] if st['elevation'] is not None else '?'} m")
            item.setData(Qt.ItemDataRole.UserRole, st)
            listing.addItem(item)
        listing.setCurrentRow(0)
        lay.addWidget(listing)
        box = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        box.accepted.connect(dialog.accept)
        box.rejected.connect(dialog.reject)
        lay.addWidget(box)
        if not dialog.exec() or listing.currentItem() is None:
            return
        station = listing.currentItem().data(Qt.ItemDataRole.UserRole)
        folder = os.path.join(self.folder.filePath().strip() or self._default_scene_dir(), "weather")
        target = os.path.join(folder, station["station"] + ".epw")
        self.message(f"Downloading {station['station']} …")
        QApplication.processEvents()
        try:
            epw.download_station(station["url"], target)
        except epw.EpwError as exc:
            self.message(str(exc), error=True)
            return
        self.epw.setFilePath(target)
        self.message(f"Weather file ready: {os.path.basename(target)} ({station['distance_km']} km away).")

    def download_osm(self) -> None:
        from ..core import osm

        extent, crs = self._scene_extent(self._selected_specs())
        out_dir = self.folder.filePath().strip() or self._default_scene_dir()
        path = os.path.join(out_dir, "osm", "osm_buildings_trees.gpkg")
        self._set_busy(True)
        try:
            info = osm.download_to_gpkg(extent, crs, path, progress=lambda m: self._progress(None, m))
        except osm.OsmError as exc:
            self.message(str(exc), error=True)
            return
        except Exception as exc:  # noqa: BLE001
            self.message(f"OSM download failed: {exc}", error=True)
            QgsApplication.messageLog().logMessage(traceback.format_exc(), "02 Geo3D Analyzer")
            return
        finally:
            self._set_busy(False)
        added = []
        for name, label in (("osm_buildings", "OSM buildings"), ("osm_trees", "OSM trees")):
            layer = QgsVectorLayer(f"{path}|layername={name}", label, "ogr")
            if layer.isValid() and layer.featureCount() > 0:
                QgsProject.instance().addMapLayer(layer)
                added.append(layer.id())
        self.refresh_layers()
        for row in self.rows:
            if row.layer.id() in added:
                row.check.setChecked(True)
                row.height.setExpression('"height_m"')
                if row.layer.fields().indexOf("min_height_m") >= 0:
                    row.base.setExpression('"min_height_m"')
        self.message(f"OSM: {info['buildings']} buildings and {info['trees']} trees ({info['crs']}). "
                     "Heights come from OSM height/levels tags, otherwise from the building type.")

    # ------------------------------------------------------------ viewer link
    def _watch_selection(self) -> None:
        for layer in self._watched:
            with contextlib.suppress(TypeError, RuntimeError):
                layer.selectionChanged.disconnect(self._push_selection)
        self._watched = []
        if self.writer is None:
            return
        for entry in self.writer.manifest.get("layers", []):
            layer = QgsProject.instance().mapLayer(entry.get("sourceLayerId", ""))
            if layer is not None:
                layer.selectionChanged.connect(self._push_selection)
                self._watched.append(layer)

    def _push_selection(self, *args) -> None:
        from ..core.results import viewer_ids_for_selection

        if self.writer is not None:
            self.server.bridge.set_selection(viewer_ids_for_selection(self.writer.manifest, self.scene_dir))

    def _poll_viewer(self) -> None:
        from ..core.results import ResultError, select_in_qgis

        if self.writer is None:
            return
        for payload in self.server.bridge.pop_results():
            try:
                self.message(self.writer.handle(payload))
            except ResultError as exc:
                self.message(f"Result rejected: {exc}", error=True)
            except Exception as exc:  # noqa: BLE001
                self.message(f"Could not add the result: {exc}", error=True)
                QgsApplication.messageLog().logMessage(traceback.format_exc(), "02 Geo3D Analyzer")
        for payload in self.server.bridge.pop_picks():
            text = select_in_qgis(self.writer.manifest, self.scene_dir, payload)
            if text:
                self.iface.statusBarIface().showMessage(text, 4000)

    def shutdown(self) -> None:
        self.timer.stop()
        self.server.stop()
        for layer in self._watched:
            with contextlib.suppress(TypeError, RuntimeError):
                layer.selectionChanged.disconnect(self._push_selection)
        self._watched = []
        project = QgsProject.instance()
        with contextlib.suppress(TypeError, RuntimeError):
            project.layersAdded.disconnect(self._schedule_refresh)
        with contextlib.suppress(TypeError, RuntimeError):
            project.layersRemoved.disconnect(self._schedule_refresh)


def _deleted(layer) -> bool:
    try:
        layer.id()
    except RuntimeError:
        return True
    return False
