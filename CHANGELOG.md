# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-14

First release.

### Added
- Three-step QGIS panel: terrain (DEM, area, grid), objects (role, height expression, QGIS colours, scenario A/B, climate rasters, weather file) and Open in 3D.
- OpenStreetMap buildings and trees download for the scene area, with heights from OSM tags.
- Nearest TMYx weather station lookup (17,312 stations) and download from climate.onebuilding.org.
- Browser viewer (Three.js): terrain shading (natural, elevation, slope, aspect, hillshade), contours, vertical exaggeration; extruded buildings and walls, instanced trees and poles, draped surfaces, platforms, section lines; colour, filter and height rules per layer; sun clock with live shadows.
- GPU analyses on ground, roofs and facades: sun hours and shadow share, sky view factor, annual irradiation and PV yield, viewshed; tiled for large areas.
- Pedestrian wind screening, UTCI with a SolarCal mean radiant temperature, heat-island morphology and approximate Local Climate Zones.
- Terrain sections with building silhouettes (PNG, CSV, DXF), water-level flooding, cut and fill with a balancing level.
- Scenario A/B difference maps and NSGA-II building-height optimisation.
- Results to QGIS as GeoTIFF layers and a results GeoPackage per building layer; two-way selection.
