# -*- coding: utf-8 -*-
"""Pure-Python tests (no QGIS): geometry helpers, OSM tags, EPW index."""
from __future__ import annotations

import io
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zero2geospatial3d.core import epw, geo, osm_tags  # noqa: E402


def test_utm_zone():
    assert geo.utm_epsg_for(27.14, 38.42) == 32635   # Izmir
    assert geo.utm_epsg_for(-58.4, -34.6) == 32721   # Buenos Aires
    assert geo.utm_epsg_for(180.0, 0.0) == 32660


def test_grid_shape_caps_the_longest_side():
    cols, rows, cell = geo.grid_shape(600, 500, 5)
    assert (cols, rows, cell) == (120, 100, 5)
    cols, rows, cell = geo.grid_shape(10000, 4000, 1)
    assert cols == 1024 and cell == pytest.approx(10000 / 1024)
    assert rows == 410
    with pytest.raises(ValueError):
        geo.grid_shape(0, 10, 1)


def test_field_names_are_unique_and_safe():
    used = {"sun_h"}
    assert geo.field_name("Sun H", used) == "sun_h_2"
    assert geo.field_name("3d value", used) == "v_3d_value"
    assert geo.safe_name("My layer: 1/2") == "My_layer_12"


def test_ring_area_sign():
    ccw = [(0, 0), (10, 0), (10, 10), (0, 10)]
    assert geo.ring_area(ccw) == 100
    assert geo.ring_area(list(reversed(ccw))) == -100


@pytest.mark.parametrize("text,expected", [
    ("12", 12.0), ("12.5 m", 12.5), ("12,5", 12.5), ("40'", 40 * 0.3048), ("3;4", 3.0), ("~7", 7.0),
    ("120 cm", 1.2), ("abc", None), (None, None),
])
def test_parse_number(text, expected):
    got = osm_tags.parse_number(text)
    assert got == pytest.approx(expected) if expected is not None else got is None


def test_building_height_priority():
    assert osm_tags.building_height({"building": "yes", "height": "20", "min_height": "5"}) == (15.0, 7, "height")
    assert osm_tags.building_height({"building": "yes", "building:levels": "4", "roof:levels": "1"}) == (15.0, 5, "levels")
    assert osm_tags.building_height({"building": "house"}) == (6.0, 2, "default")
    assert osm_tags.building_height({"building": "warehouse"}) == (7.0, 1, "default")
    assert osm_tags.tree_height({"height": "200"}) == 8.0


def test_epw_index_and_nearest_station():
    index = epw.load_index()
    assert len(index["rows"]) > 15000
    near = epw.nearest_stations(41.01, 28.97, 3, index)    # Istanbul
    assert near[0]["distance_km"] < 30
    assert near[0]["url"].startswith("https://climate.onebuilding.org/WMO_Region_6_Europe/TUR_Turkiye/")
    assert near[0]["distance_km"] <= near[1]["distance_km"] <= near[2]["distance_km"]
    assert epw.haversine_km(0, 0, 0, 1) == pytest.approx(111.19, abs=0.05)


def test_extract_epw_rejects_bad_archives(tmp_path):
    with pytest.raises(epw.EpwError):
        epw.extract_epw(b"not a zip", str(tmp_path / "a.epw"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.txt", "no weather here")
    with pytest.raises(epw.EpwError):
        epw.extract_epw(buf.getvalue(), str(tmp_path / "b.epw"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("w.epw", "NOT,A,LOCATION\n")
    with pytest.raises(epw.EpwError):
        epw.extract_epw(buf.getvalue(), str(tmp_path / "c.epw"))


def test_utc_offset_choice():
    assert geo.choose_utc_offset(27.14, 3.0) == 3.0      # Izmir analysed from Turkey
    assert geo.choose_utc_offset(-74.0, 3.0) == -5.0     # New York analysed from Turkey
    assert geo.choose_utc_offset(27.14, None) == 2.0     # no machine zone: nautical guess
