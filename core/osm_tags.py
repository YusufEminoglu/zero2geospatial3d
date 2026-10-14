# -*- coding: utf-8 -*-
"""OSM tag interpretation (pure Python, no QGIS)."""
from __future__ import annotations

import re

FLOOR_HEIGHT_M = 3.0

# Floor counts by OSM ``building`` type, used only when OSM has neither
# building:levels nor height. Unknown types fall back to 3.
DEFAULT_FLOORS = {
    "apartments": 4, "residential": 4, "dormitory": 5,
    "house": 2, "detached": 2, "terrace": 2, "semidetached_house": 2, "bungalow": 1,
    "commercial": 3, "office": 5, "retail": 2, "supermarket": 1, "kiosk": 1,
    "industrial": 1, "warehouse": 1, "manufacture": 1, "hangar": 1,
    "school": 3, "university": 4, "college": 4, "kindergarten": 2,
    "hospital": 5, "clinic": 3,
    "church": 1, "mosque": 1, "temple": 1, "synagogue": 1, "cathedral": 2, "chapel": 1,
    "public": 3, "civic": 3, "government": 4, "townhall": 3,
    "garage": 1, "garages": 1, "shed": 1, "hut": 1, "roof": 1, "carport": 1,
}
# Single-storey types read taller than 3 m per floor.
TALL_SINGLE_STOREY = {"industrial": 7.0, "warehouse": 7.0, "hangar": 9.0, "manufacture": 6.0,
                      "supermarket": 5.0, "church": 10.0, "mosque": 10.0, "cathedral": 18.0,
                      "temple": 8.0, "synagogue": 8.0, "chapel": 6.0}

_NUMBER = r"([-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+))"


def parse_number(value):
    """Parse an OSM numeric tag ('12', '12.5 m', "40'", '3;4') -> metres/float or None."""
    if value is None:
        return None
    text = str(value).split(";", 1)[0].strip().lstrip("~").strip()
    feet = re.fullmatch(_NUMBER + r"\s*(?:ft|feet|foot|['′])(?:\s*" + _NUMBER + r"\s*(?:in|inches?|[\"″]))?",
                        text, re.IGNORECASE)
    if feet:
        return float(feet.group(1).replace(",", ".")) * 0.3048 + \
            float((feet.group(2) or "0").replace(",", ".")) * 0.0254
    match = re.fullmatch(_NUMBER + r"\s*(m|met(?:er|re)s?|cm|km|ft|feet|foot|in|inches?)?", text, re.IGNORECASE)
    if not match:
        return None
    number = float(match.group(1).replace(",", "."))
    unit = (match.group(2) or "").lower()
    if unit == "cm":
        return number / 100.0
    if unit == "km":
        return number * 1000.0
    if unit in ("ft", "feet", "foot"):
        return number * 0.3048
    if unit.startswith("in"):
        return number * 0.0254
    return number


def building_height(tags: dict) -> tuple[float, int, str]:
    """(top_m, levels, source) for an OSM building or building:part.

    top_m is the height of the top above the ground, as the OSM ``height``
    key defines it (Simple 3D Buildings); the bottom of a raised part is
    min_height(). source is 'height', 'levels' or 'default' so a user can tell
    measured heights from guesses.
    """
    kind = (tags.get("building") or tags.get("building:part") or "").strip().lower()
    levels = None
    for key in ("building:levels", "levels"):
        n = parse_number(tags.get(key))
        if n is not None and n > 0:
            levels = max(1, int(round(n)))
            break
    roof = parse_number(tags.get("roof:levels"))
    roof_levels = max(0, int(round(roof))) if roof else 0
    height = parse_number(tags.get("height"))
    if height is not None and 0 < height < 1000:
        total_levels = levels or max(1, int(round(height / FLOOR_HEIGHT_M)))
        return round(max(1.0, height), 2), total_levels, "height"
    if levels is not None:
        total = levels + roof_levels
        return round(total * FLOOR_HEIGHT_M, 2), total, "levels"
    floors = DEFAULT_FLOORS.get(kind, 3)
    if floors == 1 and kind in TALL_SINGLE_STOREY:
        return TALL_SINGLE_STOREY[kind], 1, "default"
    return round((floors + roof_levels) * FLOOR_HEIGHT_M, 2), floors + roof_levels, "default"


def min_height(tags: dict) -> float:
    """Bottom of a building part above the ground: min_height, else
    building:min_level floors (levels the part skips, Simple 3D Buildings)."""
    h = parse_number(tags.get("min_height"))
    if h is not None and 0 < h < 1000:
        return round(h, 2)
    lv = parse_number(tags.get("building:min_level"))
    if lv is not None and lv > 0:
        return round(lv * FLOOR_HEIGHT_M, 2)
    return 0.0


def tree_height(tags: dict) -> float:
    h = parse_number(tags.get("height"))
    if h is not None and 1 <= h <= 80:
        return round(h, 2)
    return 8.0
