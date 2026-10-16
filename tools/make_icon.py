# -*- coding: utf-8 -*-
"""Draw icons/icon.png and icons/quick3d.png with Qt (run with a QGIS Python launcher).

    python-qgis-ltr.bat tools/make_icon.py

The plugin icon is an isometric DEM block: a lit height field with
hypsometric colours, contour lines and layered sides, carrying a cluster of
buildings whose walls show an analysis gradient (what the viewer draws for
sky view or daylight), with their shadows and the sun. Everything is drawn
from geometry here, so the icon can be regenerated at any size.
"""
from __future__ import annotations

import math
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from qgis.PyQt.QtCore import QPointF, Qt  # noqa: E402
from qgis.PyQt.QtGui import (  # noqa: E402
    QBrush,
    QColor,
    QImage,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
    QRadialGradient,
)
from qgis.PyQt.QtWidgets import QApplication  # noqa: E402

SIZE = 512
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Isometric frame: the block spans x, y in [0, 1]; z in block units.
CX, CY, W = 256.0, 318.0, 238.0
ZS = 120.0          # screen pixels per unit of height
THICK = 0.42        # block thickness below z = 0

LIGHT = (0.62, -0.30, 0.72)    # towards the light: from the right, high
BANDS = ["#2f9e8f", "#3fb19f", "#5cc3b0", "#86d4c2", "#b4e5d8", "#e3f4ee"]
STRATA = ["#1c6e78", "#175d68", "#124b56", "#0d3a45"]
VIRIDIS = ["#46327e", "#365c8d", "#277f8e", "#1fa187", "#4ac16d", "#a0da39", "#fde725"]


def screen(x, y, z):
    return QPointF(CX + (x - y) * W, CY + (x + y - 1) * W / 2 - z * ZS)


def height(x, y):
    """A hill at the back left, a shoulder at the back right, flat ground in front."""
    h = 0.62 * math.exp(-((x - 0.18) ** 2 + (y - 0.30) ** 2) / 0.055)
    h += 0.30 * math.exp(-((x - 0.42) ** 2 + (y - 0.08) ** 2) / 0.03)
    h += 0.05 * math.sin(6 * x) * math.cos(5 * y)
    return max(0.0, h) + 0.04


def mix(c1, c2, t):
    a, b = QColor(c1), QColor(c2)
    return QColor(int(a.red() + (b.red() - a.red()) * t), int(a.green() + (b.green() - a.green()) * t),
                  int(a.blue() + (b.blue() - a.blue()) * t))


def shade(color, factor):
    c = QColor(color)
    return QColor(min(255, int(c.red() * factor)), min(255, int(c.green() * factor)), min(255, int(c.blue() * factor)))


def band_color(h):
    t = max(0.0, min(0.999, (h - 0.04) / 0.62)) * (len(BANDS) - 1)
    i = int(t)
    return mix(BANDS[i], BANDS[i + 1], t - i)


def draw_block(p, n=72, contours=True, flat_front=None):
    """The terrain block: sides with strata, then the lit height field and its contours."""
    p.setPen(Qt.PenStyle.NoPen)

    def side(points_top):
        """Strata from the terrain profile down to the block bottom."""
        layers = len(STRATA)
        for k in range(layers):
            z_top = [0.0 if k else None for _ in points_top]
            top = [(x, y, (h if k == 0 else -THICK * k / layers)) for (x, y, h), _ in zip(points_top, z_top)]
            bottom = [(x, y, -THICK * (k + 1) / layers) for (x, y, _h) in points_top]
            poly = QPolygonF([screen(*q) for q in top] + [screen(*q) for q in reversed(bottom)])
            p.setBrush(QColor(STRATA[k]))
            p.drawPolygon(poly)
        # A light rim along the top edge.
        p.setPen(QPen(QColor(255, 255, 255, 90), 2))
        for a, b in zip(points_top, points_top[1:]):
            p.drawLine(screen(*a), screen(*b))
        p.setPen(Qt.PenStyle.NoPen)

    m = 60
    side([(1.0, j / m, height(1.0, j / m)) for j in range(m + 1)])           # right front face (x = 1)
    side([(i / m, 1.0, height(i / m, 1.0)) for i in range(m + 1)])           # left front face (y = 1)

    # Height field, back to front.
    hs = [[height(i / n, j / n) for j in range(n + 1)] for i in range(n + 1)]
    cells = sorted(((i, j) for i in range(n) for j in range(n)), key=lambda c: c[0] + c[1])
    lx, ly, lz = LIGHT
    for i, j in cells:
        x0, x1, y0, y1 = i / n, (i + 1) / n, j / n, (j + 1) / n
        h00, h10, h11, h01 = hs[i][j], hs[i + 1][j], hs[i + 1][j + 1], hs[i][j + 1]
        dzdx = ((h10 - h00) + (h11 - h01)) / 2 * n * 1.4
        dzdy = ((h01 - h00) + (h11 - h10)) / 2 * n * 1.4
        nl = math.sqrt(dzdx * dzdx + dzdy * dzdy + 1)
        lam = max(0.0, (-dzdx * lx - dzdy * ly + lz) / nl)
        base = band_color((h00 + h10 + h11 + h01) / 4)
        if flat_front and flat_front(x0, y0):
            base = mix(base, QColor("#d9efe7"), 0.35)
        c = shade(base, 0.70 + 0.50 * lam)
        quad = QPolygonF([screen(x0, y0, h00), screen(x1, y0, h10), screen(x1, y1, h11), screen(x0, y1, h01)])
        p.setBrush(c)
        p.setPen(QPen(c, 0.8))
        p.drawPolygon(quad)
    if not contours:
        return
    # Contour lines by marching squares.
    cpen = QPen(QColor(255, 255, 255, 150), 2.0)
    cpen.setCapStyle(Qt.PenCapStyle.RoundCap)
    p.setPen(cpen)
    for level in [0.12, 0.22, 0.32, 0.42, 0.52, 0.62]:
        for i in range(n):
            for j in range(n):
                corners = [(i / n, j / n, hs[i][j]), ((i + 1) / n, j / n, hs[i + 1][j]),
                           ((i + 1) / n, (j + 1) / n, hs[i + 1][j + 1]), (i / n, (j + 1) / n, hs[i][j + 1])]
                pts = []
                for k in range(4):
                    a, b = corners[k], corners[(k + 1) % 4]
                    if (a[2] - level) * (b[2] - level) < 0:
                        t = (level - a[2]) / (b[2] - a[2])
                        pts.append(screen(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, level))
                if len(pts) == 2:
                    p.drawLine(pts[0], pts[1])


def draw_buildings(p):
    # (x, y, footprint dx, dy, height) on the flat front of the block.
    blocks = [(0.52, 0.48, 0.14, 0.12, 0.70), (0.71, 0.44, 0.12, 0.14, 1.05), (0.57, 0.66, 0.12, 0.12, 0.50),
              (0.75, 0.64, 0.14, 0.12, 0.66), (0.88, 0.40, 0.09, 0.10, 0.42), (0.66, 0.82, 0.13, 0.10, 0.34),
              (0.86, 0.80, 0.10, 0.09, 0.46)]
    # Shadows first (light from the back right: they fall to the front left, +y).
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(8, 40, 46, 95))
    for x, y, dx, dy, hgt in blocks:
        z = height(x + dx / 2, y + dy / 2)
        reach = hgt * 0.55
        poly = QPolygonF([screen(x, y, z), screen(x + dx, y, z), screen(x + dx, y + dy + reach, z),
                          screen(x, y + dy + reach, z)])
        p.drawPolygon(poly)
    for x, y, dx, dy, hgt in sorted(blocks, key=lambda b: b[0] + b[1]):
        z0 = min(height(x, y), height(x + dx, y), height(x, y + dy), height(x + dx, y + dy))
        z1 = z0 + hgt
        outline = QPen(QColor(16, 40, 60, 160), 1.4)
        # Right face (x = x + dx): analysis gradient, darker side.
        right = QPolygonF([screen(x + dx, y, z0), screen(x + dx, y + dy, z0), screen(x + dx, y + dy, z1), screen(x + dx, y, z1)])
        left = QPolygonF([screen(x, y + dy, z0), screen(x + dx, y + dy, z0), screen(x + dx, y + dy, z1), screen(x, y + dy, z1)])
        for face, factor in ((right, 0.86), (left, 1.0)):
            r = face.boundingRect()
            g = QLinearGradient(QPointF(0, r.bottom()), QPointF(0, r.top()))
            frac = min(1.0, hgt / 1.05)
            for k, col in enumerate(VIRIDIS):
                t = k / (len(VIRIDIS) - 1)
                if t <= frac + 1e-9:
                    g.setColorAt(t / frac if frac > 0 else 0, shade(col, factor))
            p.setBrush(QBrush(g))
            p.setPen(outline)
            p.drawPolygon(face)
        roof = QPolygonF([screen(x, y, z1), screen(x + dx, y, z1), screen(x + dx, y + dy, z1), screen(x, y + dy, z1)])
        p.setBrush(QColor("#ffffff"))
        p.drawPolygon(roof)
        # Window bands: a quiet rhythm on the lit face.
        p.setPen(QPen(QColor(255, 255, 255, 70), 1.1))
        floors = max(2, int(hgt / 0.09))
        for f in range(1, floors):
            zz = z0 + hgt * f / floors
            p.drawLine(screen(x, y + dy, zz), screen(x + dx, y + dy, zz))
            p.drawLine(screen(x + dx, y, zz), screen(x + dx, y + dy, zz))


def draw_sun(p, centre=QPointF(434, 78), r=40.0):
    glow = QRadialGradient(centre, r * 2.6)
    glow.setColorAt(0, QColor(255, 214, 90, 150))
    glow.setColorAt(1, QColor(255, 214, 90, 0))
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QBrush(glow))
    p.drawEllipse(centre, r * 2.6, r * 2.6)
    g = QRadialGradient(QPointF(centre.x() - r * 0.3, centre.y() - r * 0.3), r * 1.3)
    g.setColorAt(0, QColor("#fff3b0"))
    g.setColorAt(1, QColor("#ffb81f"))
    p.setBrush(QBrush(g))
    p.drawEllipse(centre, r, r)
    # The sun's path over the block.
    pen = QPen(QColor(255, 200, 60, 170), 3)
    pen.setStyle(Qt.PenStyle.DashLine)
    p.setPen(pen)
    p.setBrush(Qt.BrushStyle.NoBrush)
    path = QPainterPath(QPointF(64, 168))
    path.quadTo(QPointF(240, -6), centre)
    p.drawPath(path)


def new_image():
    img = QImage(SIZE, SIZE, QImage.Format.Format_ARGB32)
    img.fill(QColor(0, 0, 0, 0))
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    return img, p


def plugin_icon(out):
    img, p = new_image()
    draw_sun(p)
    draw_block(p, flat_front=lambda x, y: x > 0.5 and y > 0.38)
    draw_buildings(p)
    p.end()
    img.save(out)
    print("wrote", out)


def quick_icon(out):
    """Toolbar icon for Quick 3D: the bare terrain block and a bolt."""
    img, p = new_image()
    draw_block(p, n=56)
    c = QPointF(404, 404)
    p.setPen(QPen(QColor("#ffffff"), 10))
    p.setBrush(QColor("#ff8a1f"))
    p.drawEllipse(c, 84, 84)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor("#ffffff"))
    bolt = [(14, -66), (-34, 8), (-4, 8), (-18, 66), (36, -10), (6, -10), (24, -66)]
    p.drawPolygon(QPolygonF([QPointF(c.x() + bx, c.y() + by) for bx, by in bolt]))
    p.end()
    img.save(out)
    print("wrote", out)


def main():
    app = QApplication.instance() or QApplication(sys.argv)
    icons = os.path.join(HERE, "icons")
    plugin_icon(os.path.join(icons, "icon.png"))
    quick_icon(os.path.join(icons, "quick3d.png"))
    del app


if __name__ == "__main__":
    main()
