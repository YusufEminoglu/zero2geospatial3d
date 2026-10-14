# -*- coding: utf-8 -*-
"""Write a synthetic scene package (no QGIS needed) for viewer tests.

    py -3 tests/make_demo_scene.py <out_dir> [--buildings N]

A hill, a grid of building blocks with varied heights, one tower, trees, a
park surface, a section line, a platform and a scenario-B block, in the same
format SceneExporter writes.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct


def lcg(seed=7):
    state = seed

    def rnd():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        return state / 0x7FFFFFFF

    return rnd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--buildings", type=int, default=400)
    ap.add_argument("--size", type=float, default=800.0)
    ap.add_argument("--cell", type=float, default=4.0, help="terrain cell (m); 1 m over 4 km gives a 16 M-cell DEM")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rnd = lcg()
    size = args.size
    cell = args.cell
    cols = rows = int(size / cell)
    min_x = -cols * cell / 2 + cell / 2
    max_y = rows * cell / 2 - cell / 2
    import array

    values = array.array("f")
    for r in range(rows):
        y = max_y - r * cell
        for c in range(cols):
            x = min_x + c * cell
            # A hill, a gentle tilt and small ripples (visible only on fine grids).
            values.append(40 + 25 * math.exp(-((x - 180) ** 2 + (y - 160) ** 2) / (2 * 140 ** 2)) - 0.012 * y
                          + 1.5 * math.sin(x / 23.0) * math.cos(y / 31.0))
    with open(os.path.join(args.out, "terrain.bin"), "wb") as handle:
        values.tofile(handle)

    def feature(fid, geom, props):
        p = {"_id": fid}
        p.update(props)
        return {"type": "Feature", "properties": p, "geometry": geom}

    def rect(cx, cy, w, d):
        return [[[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2],
                 [cx - w / 2, cy + d / 2], [cx - w / 2, cy - d / 2]]]

    buildings = []
    n_side = max(2, int(math.ceil(math.sqrt(args.buildings))))
    spacing = (size * 0.8) / n_side
    uses = ["residential", "office", "retail", "school"]
    colors = {"residential": "#e3d6c2", "office": "#b9c7d6", "retail": "#e8b9a0", "school": "#c9d9a6"}
    fid = 0
    for i in range(n_side):
        for j in range(n_side):
            if fid >= args.buildings:
                break
            cx = -size * 0.4 + spacing * (i + 0.5)
            cy = -size * 0.4 + spacing * (j + 0.5)
            if abs(cx - 40) < 70 and abs(cy + 60) < 70:
                continue  # leave room for the park
            w = spacing * (0.45 + 0.3 * rnd())
            d = spacing * (0.45 + 0.3 * rnd())
            floors = 1 + int(rnd() * 9)
            use = uses[int(rnd() * len(uses))]
            fid += 1
            buildings.append(feature(fid, {"type": "MultiPolygon", "coordinates": [rect(cx, cy, w, d)]},
                                     {"_h": floors * 3.2, "_c": colors[use], "floors": floors, "use": use,
                                      "name": f"B{fid}"}))
    fid += 1
    tower = rect(-60, 120, 26, 26)
    hole = [[-64, 116], [-64, 124], [-56, 124], [-56, 116], [-64, 116]]  # courtyard (clockwise)
    buildings.append(feature(fid, {"type": "MultiPolygon", "coordinates": [[tower[0], hole]]},
                             {"_h": 96.0, "_c": "#8fa3b8", "floors": 30, "use": "office", "name": "Tower"}))
    trees = [feature(k + 1, {"type": "MultiPoint", "coordinates": [[40 + 120 * (rnd() - 0.5), -60 + 120 * (rnd() - 0.5)]]},
                     {"_h": 6 + 8 * rnd(), "_c": "#4f8a3c", "species": "plane"}) for k in range(60)]
    park = [feature(1, {"type": "MultiPolygon", "coordinates": [rect(40, -60, 130, 130)]}, {"_h": 0, "_c": "#9cc58a", "name": "Park"})]
    section = [feature(1, {"type": "MultiLineString", "coordinates": [[[-380, -300], [380, 320]]]}, {"_h": 0, "_c": "#e4572e", "name": "A-A"})]
    platform = [feature(1, {"type": "MultiPolygon", "coordinates": [rect(250, -250, 90, 60)]}, {"_h": 0, "_c": "#c9a46b"})]
    scen_b = [feature(1, {"type": "MultiPolygon", "coordinates": [rect(40, -20, 60, 30)]},
                      {"_h": 45.0, "_c": "#d9827a", "floors": 14, "use": "residential", "name": "Proposal"})]

    def fields(features):
        out = []
        for k, v in features[0]["properties"].items():
            if k.startswith("_"):
                continue
            out.append({"name": k, "type": "number" if isinstance(v, (int, float)) else "text"})
        return out

    layers = []
    specs = [("Buildings", buildings, "polygon", "buildings", "both", 9),
             ("Trees", trees, "point", "trees", "both", 8),
             ("Park", park, "polygon", "surfaces", "both", 0),
             ("Section lines", section, "line", "sections", "both", 0),
             ("Platform", platform, "polygon", "platforms", "both", 0),
             ("Proposal B", scen_b, "polygon", "buildings", "B", 9)]
    for index, (name, feats, kind, role, scenario, default_h) in enumerate(specs, start=1):
        fname = f"L{index}.geojson"
        with open(os.path.join(args.out, fname), "w", encoding="utf-8") as handle:
            json.dump({"type": "FeatureCollection", "features": feats}, handle, separators=(",", ":"))
        with open(os.path.join(args.out, f"L{index}.ids.json"), "w", encoding="utf-8") as handle:
            json.dump(list(range(1, len(feats) + 1)), handle)
        layers.append({"id": f"L{index}", "name": name, "file": fname, "kind": kind, "role": role,
                       "scenario": scenario, "count": len(feats), "fields": fields(feats), "heightExpr": "",
                       "defaultHeight": default_h, "colorMode": "qgis", "defaultColor": "#cccccc",
                       "sourceLayerId": f"demo_{index}", "sourceCrs": "EPSG:32635"})
    manifest = {
        "format": "zero2geospatial3d-scene", "version": 1, "title": "Demo district",
        "created": "2026-10-14T12:00:00", "crs": {"authid": "EPSG:32635", "wkt": ""},
        "origin": [500000.0, 4250000.0],
        "extent": {"minX": -size / 2, "minY": -size / 2, "maxX": size / 2, "maxY": size / 2},
        "geo": {"lat": 38.4, "lon": 27.14, "utcOffset": 3.0},
        "grid": {"cols": cols, "rows": rows, "cell": cell, "minX": min_x, "maxY": max_y},
        "terrain": {"file": "terrain.bin", "min": float(min(values)), "max": float(max(values)), "source": "synthetic hill"},
        "layers": layers, "rasters": [], "weather": None, "warnings": [],
    }
    with open(os.path.join(args.out, "scene.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
    print(f"demo scene: {len(buildings)} buildings -> {args.out}")


if __name__ == "__main__":
    main()
