# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Tiled terrain with level of detail: DEMs up to 4096 x 4096 cells (new "Detail limit" in step 1) stay smooth; tiles near the camera are drawn at full resolution, distant ones coarser, with skirts against cracks; analysis areas are drawn at the analysis resolution while they run.
- Buildings on slopes: stand them on the lowest, average or highest ground under the footprint; walls reach down to the ground at every corner, so a plinth shows on the downhill side.
- OSM building parts (Simple 3D Buildings): parts replace their outline, keep their own height and min_height (towers on podiums, raised sections), inherit the outline's name and type, and stand on one common ground.
- Optional "Bottom" expression for building layers (e.g. min_height).
- Quick 3D: show a DEM alone in 3D with one click, from the panel or the toolbar.

### Changed
- Automatic grid uses the DEM's own resolution.
- The sun clock uses the computer's standard time zone when it matches the scene's longitude.
- Contours are traced in one pass over the grid; hillshade no longer allocates slope and aspect grids (large DEMs use about half the memory).
- Shadow bias follows the shadow-map texel size, so shadows touch the walls that cast them.

### Fixed
- A layer row reported the "Existing" scenario and no bottom height while the panel was hidden.

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
