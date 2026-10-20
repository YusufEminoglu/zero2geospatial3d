# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.2] - 2026-10-20

### UI & Documentation Integration
- Reference manual themed to match 02 Geo3D Electric Blue design system (`#1f6feb`, dark slate aesthetic): [https://geophilo.com/zero2geospatial3d/](https://geophilo.com/zero2geospatial3d/).
- Direct minimalist `Manual ↗` button in dock panel header.
- QGIS Plugins menu actions: `Plugins -> 02 Geo3D Analyzer -> Online Reference Manual...` and `About 02 Geo3D Analyzer...`.
- Replaced outdated repository links with official documentation portal.

## [1.0.1] - 2026-10-20

### Documentation & Reference Manual
- Complete Illustrated Reference Manual added (`docs/index.html` with step-by-step visual guides, formulas, standards, and screenshot walkthrough): [https://yusufeminoglu.github.io/zero2geospatial3d/](https://yusufeminoglu.github.io/zero2geospatial3d/).
- Direct manual access button from the QGIS panel header and the 3D web viewer top bar.

### Stability & Compatibility
- Fixed QGIS 3.44 LTR 3D view crash (`Windows fatal exception: access violation` in SIP wrapper `PyInit_sip`): QGIS 3D canvas management now safely inspects canvas widgets without calling broken `createNewMapCanvas3D`/`mapCanvases3D` SIP methods, triggering native actions with clean lifecycle management.

## [1.0.0] - 2026-10-16

First release.

### QGIS panel
- Three numbered steps: terrain (DEM and area), objects (role, height and bottom expressions, QGIS colours, scenario A/B) and Open in 3D; layer rows open their settings when ticked; grid, detail limit, folder and climate data in folding sections. Follows the QGIS light or dark theme.
- Quick 3D: a DEM alone in 3D with one click, from the panel or the toolbar.
- OpenStreetMap buildings (with building parts: towers on podiums keep their own height and min_height) and trees for the scene area.
- Nearest TMYx weather station (17,312 stations) downloaded from climate.onebuilding.org, or your own EnergyPlus weather file.
- QGIS 3D view: the DEM as the project's terrain, the ticked buildings extruded and coloured by class, in QGIS's own 3D map view.

### Viewer
- Three.js viewer in the browser: terrain shading (natural, elevation, slope, aspect, hillshade), contours, vertical exaggeration; extruded buildings and walls, trees and poles, draped surfaces, platforms and section lines; colour, filter and height rules per layer; sun clock with live shadows.
- Tiled terrain with level of detail: DEMs up to 4096 x 4096 cells stay smooth; scenes of any size up to 250 km.
- Buildings on slopes stand on the lowest, average or highest ground under the footprint, with a plinth downhill.
- Building report: click a building for its facts and every result with its rank, scenario impact, its year of outdoor comfort by season and its own wind rose; "Analyse this building"; a one-page PDF.

### Analyses (GPU, on ground, roofs and facades)
- Sun hours, hours in shade and a shadow study played with the sun clock; summer and winter side by side.
- Sky view factor; daylight on facades as the vertical sky component under the CIE overcast sky (BRE 209), with party walls left out.
- Annual irradiation and rooftop and facade PV yield, from a weather file or a clear-sky estimate.
- Viewsheds, pedestrian wind screening (Lawson classes), UTCI heat stress with a SolarCal mean radiant temperature.
- Heat-island morphology (plan and frontal area fractions, canyon ratio, roughness) and approximate Local Climate Zones.
- Climate around buildings over a year: comfortable, heat-stress and cold-stress hours, pedestrian wind and windy hours per building, by season.
- Terrain analyses: elevation, slope with slope bands, aspect, hillshade, curvature, topographic position, ruggedness and topographic wetness index; sections with building silhouettes (PNG, CSV, DXF), water-level flooding, cut and fill with a balancing level.

### Planning
- Planning check: pass or fail per building for sun on the surrounding open ground on 21 March, facade daylight (VSC of 27 % or more), daylight kept after scenario B (0.8 times the former VSC), windy hours and summer heat-stress hours; screening after BRE 209, not a formal assessment. Buildings painted green, amber or red, also in QGIS 2D and 3D; a one-page planning sheet (PDF) and a CSV, worst first.
- Planning profiles: criteria and thresholds saved and shared as JSON files.
- Scenario A and B: difference maps and per-building values in A, in B and the change, including daylight on facades.
- Building-height optimisation (NSGA-II) trading floor area against sun on the open ground, optionally within planning constraints (sun around each building, the BRE 209 daylight test for the neighbours' windows) at no extra cost per design; a full planning check of the chosen design.

### Compare and share
- Swipe between two states, or 2, 4, 6 or 8 synced panels, each with its own analysis, scenario and legend.
- Images up to 8K with title, legend, north arrow, scale bar and credits; a one-page PDF sheet; an interactive single-file HTML that opens offline; a GLB model; videos of an orbit, the sun through the day or free movement. Exports keep every compare panel.
- Every result back to QGIS: GeoTIFF layers with the viewer's colours and fields on a results GeoPackage per building layer; two-way selection.
