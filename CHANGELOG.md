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
- Export icons on the view: images up to 8K with title, legend, north arrow, scale bar and credits; a one-page PDF sheet (view, legend, statistics, notes, sun and CRS); an interactive single-file HTML that opens offline; a GLB model for Blender or SketchUp (CRS and origin in its extras); video of a 360° orbit, the sun through the day or free movement (MP4 where supported, else WebM).
- Compare views: swipe between two states, or 2, 4, 6 or 8 synced panels, each with its own analysis, scenario and legend.
- Shadow study: sun or shade at every half hour of a day, played with the sun clock (and recorded by the "sun through the day" video); "Summer ⇆ winter" opens 21 June and 21 December sun hours side by side.
- Hours in shade map (replaces the shade share map; the share stays in its statistics, with the share of ground shaded all day).
- Building report: click a building for its facts and every analysis result with its rank among the buildings; "Analyse this building" runs winter sun, sky view and annual solar (facades included) around it; a one-page PDF sheet.
- Scenario impact per building: "Run A vs B" also writes each building's value in A, in B and the change (fields `<name>_A`, `<name>_B`, `d_<name>`); the building report and its PDF show them, and the applied optimisation design (floors now and in the design, floor-area change, sun on open ground).
- Climate around buildings (year, needs an EPW): for every building's surroundings, hourly UTCI with local sky view, sun and sheltered wind over the year gives comfortable, heat-stress and cold-stress hours, plus pedestrian wind, windy hours and a wind rose per building (in the report and its PDF); an annual pedestrian-wind map.
- Climate by season: the climate year is also split into winter, spring, summer and autumn (comfortable share per season, summer heat-stress and winter cold-stress hours, winter wind); the report shows a season table and a wind rose per season, and the result has season chips for its map.
- Planning check: pass or fail for each building (selected, in the area, or scenario B) against sun on the surrounding open ground on 21 March, facade sky view as a daylight proxy, daylight kept after scenario B, windy hours and summer heat-stress hours; thresholds are editable, missing analyses run on their own, buildings are painted green, amber or red, and a one-page planning sheet (PDF) and a CSV list the buildings worst first. These are screening proxies of BRE 209, not formal assessments.
- Planning-check profiles: name a set of criteria and thresholds, save it as a JSON file, load it back or share it (e.g. one per municipality or project); the last one used is remembered, and the planning sheet and CSV name the profile.
- Planning check in QGIS: "To QGIS" styles the results layer by `check_failed` in the viewer's green, amber and red (buildings not checked in grey), in the 2D map and in QGIS's 3D view.
- Terrain analyses (Terrain tab): elevation, slope (with the area in slope bands), aspect, hillshade, curvature, topographic position, ruggedness and a topographic wetness index from the DEM, over the whole DEM or the analysis area. Each is a result like sun hours: drawn on the ground (not on roofs), chosen in any compare panel and sent to QGIS as a GeoTIFF; "Run and compare" opens them side by side in 2 to 8 panels.
- Constrained height optimisation: designs can be required to keep sun on the ground around each building (at least the profile's share with 2 h of sun, or 0.8 times the sunny area now) and daylight at the neighbours' windows (BRE 209: under 25°, or at least 0.8 times the window's vertical sky component now, taken for a long obstruction under the CIE overcast sky). Neither adds an analysis per design. Designs that break a constraint show as open orange rings; the applied design lists what it passes; "Check this design" runs the full planning check on it.
- Compare panels show class legends (aspect, visibility, sun or shade) as swatches, on screen and in exports.
- QGIS 3D view: results GeoPackages are extruded and coloured by class in QGIS's own 3D view; "QGIS 3D view" in the panel sets the DEM as terrain, extrudes the ticked building layers and opens a 3D map view.

### Changed
- Height optimisation is about four times faster (118 to 26 ms per design on a 12-building test): building ids are drawn once instead of for every design, the terrain is locked once for the whole run, and the sun pass uses shadow maps with texels of half a cell (2048 instead of 4096 for a 2 m cell; the designs rank the same as with the full pass, Spearman 0.996, at most 0.65 % apart). Under constraints the search starts from one-floor-up variants of the current design, where the feasible designs are.
- No 20 km limit on the scene area any more (a 250 km sanity limit remains); large scenes get a warning, analysis grids stay within 4096 cells a side, and the camera's clipping planes follow its distance.
- Building colours match QGIS exactly (they were drawn too light: sRGB colours were treated as linear).
- Automatic grid uses the DEM's own resolution.
- The sun clock uses the computer's standard time zone when it matches the scene's longitude.
- Contours are traced in one pass over the grid; hillshade no longer allocates slope and aspect grids (large DEMs use about half the memory).
- Shadow bias follows the shadow-map texel size, so shadows touch the walls that cast them.

### Fixed
- The planning check reused stored wind and heat fields after building heights had changed; the check of an optimised design reruns the climate year.
- Results sent to QGIS now carry the viewer's exact colours: reversed ramps (e.g. canyon H/W) arrived unreversed and the terrain ramp as Viridis; class rasters (visibility, Local Climate Zones, sun or shade) arrived on a continuous ramp and now come as a palette with their labels.
- The swipe divider stopped after its first movement: the drag rebuilt the panels and removed the divider it was holding. It now follows the pointer, with a wider grab area.
- Images, PDF sheets and videos taken while compare views were on showed a single view. They now show every panel with its caption and legend (the scene title moves into the credits line), and the scale bar is measured on one panel.
- A scene exported to the same folder as an earlier one could show the earlier scene's terrain: the server answered "not modified" for files older than the cached copy. Scene files are no longer cached.
- Facade PV counted every wall, north walls included; now only walls that receive at least the suitability share of the best unshaded wall.
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
