# -*- coding: utf-8 -*-
"""Build data/epw_stations.json.gz from the climate.onebuilding.org KML indexes.

Development tool, not shipped. One row per station (WMO id + name): the most
recent TMYx period available. Run from the plugin folder:

    py -3 tools/build_epw_index.py [cache_dir]
"""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import urllib.request

BASE = "https://climate.onebuilding.org/sources/"
REGIONS = [
    "Region1_Africa", "Region2_Asia", "Region2_Region6_Russia", "Region3_South_America",
    "Region4_USA", "Region4_Canada", "Region4_NA_CA_Caribbean", "Region5_Southwest_Pacific",
    "Region6_Europe", "Region7_Antarctica",
]
PLACEMARK = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)
URL = re.compile(r"URL (https://climate\.onebuilding\.org/\S+?\.zip)")
COORD = re.compile(r"<coordinates>\s*([-\d.]+),([-\d.]+)")
TZ = re.compile(r"GMT <b>([-+\d.]+)</b>")
ELEV = re.compile(r"Elevation <b>([-\d.]+)</b>")
PERIOD = re.compile(r"TMYx\.(\d{4})-(\d{4})\.zip$")


def fetch(region: str, cache: str) -> str:
    path = os.path.join(cache, f"{region}.kml")
    if not os.path.isfile(path):
        url = f"{BASE}{region}_TMYx_EPW_Processing_locations.kml"
        print("downloading", url)
        with urllib.request.urlopen(url, timeout=300) as response:  # noqa: S310 - fixed https URL
            data = response.read()
        with open(path, "wb") as handle:
            handle.write(data)
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()


def main() -> None:
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "_kml_cache")
    os.makedirs(cache, exist_ok=True)
    best: dict = {}
    for region in REGIONS:
        text = fetch(region, cache)
        for block in PLACEMARK.findall(text):
            url_m, coord_m = URL.search(block), COORD.search(block)
            if not url_m or not coord_m:
                continue
            url = url_m.group(1)
            if "TMYx" not in url:
                continue
            stem = url.rsplit("/", 1)[1]
            station = re.sub(r"_TMYx.*$", "", stem)
            period = PERIOD.search(url)
            rank = int(period.group(2)) * 10 + (int(period.group(2)) - int(period.group(1))) / 100 if period else 0
            lon, lat = float(coord_m.group(1)), float(coord_m.group(2))
            tz = TZ.search(block)
            elev = ELEV.search(block)
            row = [round(lat, 4), round(lon, 4), station, url.replace("https://climate.onebuilding.org/", ""),
                   float(tz.group(1)) if tz else None, float(elev.group(1)) if elev else None]
            if station not in best or rank > best[station][0]:
                best[station] = (rank, row)
    rows = sorted(r for _, r in best.values())
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "epw_stations.json.gz")
    payload = {"source": "https://climate.onebuilding.org/", "base": "https://climate.onebuilding.org/",
               "columns": ["lat", "lon", "station", "path", "utc", "elev"], "rows": rows}
    with gzip.open(out, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    print(f"{len(rows)} stations -> {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
