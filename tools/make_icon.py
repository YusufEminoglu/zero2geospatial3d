# -*- coding: utf-8 -*-
"""Draw icons/icon.png with Qt (run with a QGIS Python launcher).

    python-qgis-ltr.bat tools/make_icon.py
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from qgis.PyQt.QtCore import QPointF, Qt  # noqa: E402
from qgis.PyQt.QtGui import QBrush, QColor, QImage, QLinearGradient, QPainter, QPainterPath, QPen, QPolygonF  # noqa: E402
from qgis.PyQt.QtWidgets import QApplication  # noqa: E402

SIZE = 256


def poly(*pts):
    return QPolygonF([QPointF(x, y) for x, y in pts])


def main():
    app = QApplication.instance() or QApplication(sys.argv)
    img = QImage(SIZE, SIZE, QImage.Format.Format_ARGB32)
    img.fill(QColor(0, 0, 0, 0))
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    # Rounded tile.
    bg = QLinearGradient(0, 0, 0, SIZE)
    bg.setColorAt(0, QColor("#1f6feb"))
    bg.setColorAt(1, QColor("#0b3b8f"))
    path = QPainterPath()
    path.addRoundedRect(8, 8, SIZE - 16, SIZE - 16, 44, 44)
    p.fillPath(path, QBrush(bg))
    # Sun.
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor("#ffc83d"))
    p.drawEllipse(QPointF(186, 70), 26, 26)
    # Terrain.
    p.setBrush(QColor("#7fb069"))
    p.drawPolygon(poly((24, 200), (70, 168), (110, 182), (160, 150), (232, 186), (232, 232), (24, 232)))
    # Extruded block: front, side, roof.
    p.setPen(QPen(QColor("#0b2a5e"), 3))
    p.setBrush(QColor("#f2efe9"))
    p.drawPolygon(poly((72, 196), (132, 214), (132, 108), (72, 90)))
    p.setBrush(QColor("#c9cfd8"))
    p.drawPolygon(poly((132, 214), (178, 192), (178, 86), (132, 108)))
    p.setBrush(QColor("#ffffff"))
    p.drawPolygon(poly((72, 90), (132, 108), (178, 86), (118, 70)))
    # Shadow wedge.
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(11, 42, 94, 110))
    p.drawPolygon(poly((72, 196), (132, 214), (98, 230), (40, 212)))
    # "02" badge.
    p.setBrush(QColor("#ffffff"))
    p.drawRoundedRect(24, 26, 64, 40, 10, 10)
    p.setPen(QColor("#1f6feb"))
    font = p.font()
    font.setPixelSize(30)
    font.setBold(True)
    p.setFont(font)
    p.drawText(24, 26, 64, 40, int(Qt.AlignmentFlag.AlignCenter), "02")
    p.end()
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons", "icon.png")
    img.save(out)
    print("wrote", out)
    del app


if __name__ == "__main__":
    main()
