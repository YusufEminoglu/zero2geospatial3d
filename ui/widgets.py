# -*- coding: utf-8 -*-
"""Small building blocks of the panel: step cards, a header, folding sections.

Colours follow the QGIS theme (light or dark) through the palette; only the
accent is fixed, the same blue as the web viewer.
"""
from __future__ import annotations

from qgis.PyQt.QtCore import QSize, Qt
from qgis.PyQt.QtGui import QColor, QIcon, QPalette
from qgis.PyQt.QtWidgets import QFrame, QHBoxLayout, QLabel, QSizePolicy, QToolButton, QVBoxLayout, QWidget
from qgis.core import QgsApplication

ACCENT = "#1f6feb"
ACCENT_HOVER = "#1a5fd0"
ACCENT_DISABLED = "#9db9ee"

PANEL_QSS = f"""
QWidget#g3dPanel QFrame#g3dCard {{
    border: 1px solid palette(mid);
    border-radius: 8px;
    background: palette(base);
}}
QWidget#g3dPanel QLabel#g3dBadge {{
    background: {ACCENT};
    color: white;
    border-radius: 11px;
    font-weight: 600;
}}
QWidget#g3dPanel QLabel#g3dCardTitle {{ font-weight: 600; }}
QWidget#g3dPanel QLabel#g3dTitle {{ font-weight: 700; }}
QWidget#g3dPanel QPushButton#g3dPrimary {{
    background: {ACCENT};
    color: white;
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    font-weight: 600;
}}
QWidget#g3dPanel QPushButton#g3dPrimary:hover {{ background: {ACCENT_HOVER}; }}
QWidget#g3dPanel QPushButton#g3dPrimary:disabled {{ background: {ACCENT_DISABLED}; }}
QWidget#g3dPanel QFrame#g3dRow {{
    border: 1px solid palette(midlight);
    border-radius: 6px;
}}
QWidget#g3dPanel QFrame#g3dRow[on="true"] {{
    border: 1px solid {ACCENT};
    background: palette(alternate-base);
}}
QWidget#g3dPanel QToolButton#g3dFold {{
    border: none;
    padding: 2px 0;
    font-weight: 600;
}}
"""


def theme_icon(name: str) -> QIcon:
    """A QGIS theme icon, or an empty icon when this QGIS has none by that name."""
    icon = QgsApplication.getThemeIcon(name)
    return icon if icon is not None else QIcon()


def muted(label: QLabel, alpha: int = 150) -> QLabel:
    """Secondary text: the theme's text colour, lighter, so it reads on light and dark themes."""
    color = QColor(label.palette().color(QPalette.ColorRole.WindowText))
    color.setAlpha(alpha)
    label.setStyleSheet(f"color: rgba({color.red()}, {color.green()}, {color.blue()}, {color.alpha()});")
    return label


def hint(text: str) -> QLabel:
    label = QLabel(text)
    label.setWordWrap(True)
    return muted(label)


class Fold(QWidget):
    """A section with a heading that opens and closes its content."""

    def __init__(self, title: str, content: QWidget, opened: bool = False, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.button = QToolButton()
        self.button.setObjectName("g3dFold")
        self.button.setText(title)
        self.button.setCheckable(True)
        self.button.setChecked(opened)
        self.button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.button.setArrowType(Qt.ArrowType.DownArrow if opened else Qt.ArrowType.RightArrow)
        self.button.toggled.connect(self._toggled)
        self.content = content
        content.setVisible(opened)
        lay.addWidget(self.button)
        lay.addWidget(content)

    def _toggled(self, on: bool) -> None:
        self.button.setArrowType(Qt.ArrowType.DownArrow if on else Qt.ArrowType.RightArrow)
        self.content.setVisible(on)


class StepCard(QFrame):
    """A numbered step: badge, title, one-line hint, then its controls in `body`."""

    def __init__(self, number: int, title: str, text: str, parent=None):
        super().__init__(parent)
        self.setObjectName("g3dCard")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(10, 10, 10, 10)
        outer.setSpacing(6)
        head = QHBoxLayout()
        head.setSpacing(8)
        badge = QLabel(str(number))
        badge.setObjectName("g3dBadge")
        badge.setFixedSize(22, 22)
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        head.addWidget(badge)
        name = QLabel(title)
        name.setObjectName("g3dCardTitle")
        head.addWidget(name)
        head.addStretch(1)
        outer.addLayout(head)
        if text:
            outer.addWidget(hint(text))
        self.body = QVBoxLayout()
        self.body.setSpacing(6)
        outer.addLayout(self.body)


class Header(QWidget):
    """Icon, name, version and what the plugin does, with a help button."""

    def __init__(self, icon_path: str, version: str, on_help, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(2, 0, 2, 2)
        lay.setSpacing(10)
        logo = QLabel()
        logo.setPixmap(QIcon(icon_path).pixmap(QSize(44, 44)))
        logo.setFixedSize(46, 46)
        lay.addWidget(logo)
        text = QVBoxLayout()
        text.setSpacing(0)
        title = QLabel("02 Geo3D Analyzer")
        title.setObjectName("g3dTitle")
        font = title.font()
        font.setPointSizeF(font.pointSizeF() * 1.25)
        title.setFont(font)
        text.addWidget(title)
        text.addWidget(hint(f"3D viewer and analyses · v{version}"))
        lay.addLayout(text, 1)
        help_button = QToolButton()
        help_button.setIcon(theme_icon("/mActionHelpContents.svg"))
        help_button.setToolTip("How to use 02 Geo3D Analyzer (opens the project page)")
        help_button.setAutoRaise(True)
        help_button.clicked.connect(on_help)
        lay.addWidget(help_button, 0, Qt.AlignmentFlag.AlignTop)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
