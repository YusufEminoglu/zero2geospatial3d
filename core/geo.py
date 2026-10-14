# -*- coding: utf-8 -*-
"""Pure-Python geometry helpers shared by the exporter and the tests.

Scene convention: coordinates are metres in a projected CRS, made local by
subtracting ``origin`` (the centre of the scene extent). The viewer maps local
(x, y) to Three.js as (x, height, -y), so +x is east and +y is north.
"""
from __future__ import annotations

import math

MAX_GRID_CELLS = 1024          # longest side of an exported raster grid
MAX_SCENE_SIDE_M = 20000.0     # refuse scenes larger than 20 km across


def utm_epsg_for(lon: float, lat: float) -> int:
    """EPSG code of the WGS84 / UTM zone containing (lon, lat)."""
    zone = int(math.floor((lon + 180.0) / 6.0) + 1)
    zone = max(1, min(60, zone))
    return (32600 if lat >= 0 else 32700) + zone


def grid_shape(width: float, height: float, cell: float | None,
               max_cells: int = MAX_GRID_CELLS) -> tuple[int, int, float]:
    """(cols, rows, cell) for an extent, with the cell grown if needed so that
    neither side exceeds ``max_cells``. ``cell=None`` means automatic."""
    if width <= 0 or height <= 0:
        raise ValueError("extent must have a positive width and height")
    longest = max(width, height)
    auto = longest / max_cells
    cell = auto if not cell or cell <= 0 else max(float(cell), auto)
    cols = max(2, int(math.ceil(width / cell)))
    rows = max(2, int(math.ceil(height / cell)))
    return cols, rows, cell


def round_coord(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def ring_area(ring) -> float:
    """Signed shoelace area of a closed or open ring of (x, y)."""
    n = len(ring)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def utc_offset_guess(lon: float) -> float:
    """Nautical time-zone guess from longitude. Only a starting value: civil
    time zones differ (Turkey is UTC+3 at about 30 degrees east), so the
    viewer lets the user change it and an EPW file overrides it."""
    return float(round(lon / 15.0))


def choose_utc_offset(lon: float, machine_offset: float | None) -> float:
    """Clock time zone for the sun: the computer's standard offset when it is
    within 1.5 h of the longitude's nautical zone (the usual case: people
    analyse places in their own country), else the nautical zone."""
    nautical = utc_offset_guess(lon)
    if machine_offset is not None and abs(machine_offset - lon / 15.0) <= 1.5:
        return float(machine_offset)
    return nautical


def safe_name(text: str, fallback: str = "layer") -> str:
    out = []
    for ch in str(text or ""):
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch in " .":
            out.append("_")
    name = "".join(out).strip("_")
    return name[:60] or fallback


def field_name(text: str, used: set, limit: int = 30) -> str:
    """A GeoPackage-safe, unique, lower-case field name."""
    base = "".join(ch if ch.isalnum() else "_" for ch in str(text or "").lower()).strip("_")
    base = (base or "value")[:limit]
    if base[0].isdigit():
        base = ("v_" + base)[:limit]
    name = base
    k = 2
    while name in used:
        suffix = f"_{k}"
        name = base[: limit - len(suffix)] + suffix
        k += 1
    used.add(name)
    return name
