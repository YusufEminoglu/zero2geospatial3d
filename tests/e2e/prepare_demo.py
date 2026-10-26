# -*- coding: utf-8 -*-
"""Add a roads layer (two roads, traffic 2 and 0.5) and, optionally, an EPW
weather file to a scene written by tests/make_demo_scene.py, so the
end-to-end sweep reaches the noise, air-quality and climate tools.

    py -3 tests/e2e/prepare_demo.py <scene_dir> [weather.epw]
"""
from __future__ import annotations

import json
import os
import shutil
import sys


def main() -> None:
    scene = sys.argv[1]
    manifest_path = os.path.join(scene, "scene.json")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    layers = manifest["layers"]
    if not any(layer["role"] == "roads" for layer in layers):
        template = next(layer for layer in layers if layer["role"] == "sections")
        index = len(layers) + 1
        layers.append(dict(template, id=f"L{index}", name="Main roads", file=f"L{index}.geojson", role="roads",
                           heightExpr='"lanes"', defaultHeight=1.0, defaultColor="#ff4f2e", count=2))
        features = [
            {"type": "Feature", "properties": {"_id": 1, "_h": 2.0, "_c": "#ff4f2e", "lanes": 2},
             "geometry": {"type": "LineString", "coordinates": [[-150, 5], [150, 5]]}},
            {"type": "Feature", "properties": {"_id": 2, "_h": 0.5, "_c": "#ff4f2e", "lanes": 1},
             "geometry": {"type": "LineString", "coordinates": [[5, -150], [5, 150]]}},
        ]
        with open(os.path.join(scene, f"L{index}.geojson"), "w", encoding="utf-8") as handle:
            json.dump({"type": "FeatureCollection", "features": features}, handle)
        with open(os.path.join(scene, f"L{index}.ids.json"), "w", encoding="utf-8") as handle:
            json.dump([1, 2], handle)
    if len(sys.argv) > 2:
        shutil.copyfile(sys.argv[2], os.path.join(scene, "weather.epw"))
        manifest["weather"] = {"file": "weather.epw", "source": os.path.basename(sys.argv[2])}
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    print(f"{scene}: roads layer added" + (", weather file added" if len(sys.argv) > 2 else ""))


if __name__ == "__main__":
    main()
