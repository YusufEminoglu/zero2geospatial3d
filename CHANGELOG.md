# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.1] - 2026-10-26

An audit of every tool: each analysis, terrain tool, comparison and export run end to end in the viewer, plus a review of the algorithms and the QGIS side.

### Fixed
- Results sent to QGIS after a re-export landed on the wrong buildings: a results GeoPackage now belongs to the set of exported features (its name carries an export stamp; earlier results files stay on disk).
- A feature added by hand to a results layer (no `g3d_id`) broke every later send; a result field that differed only in case from a source field was silently lost.
- Compare > A vs B for daylight on facades (VSC) failed with an error.
- Scenes with 16 or more layers mixed up buildings in roof and per-building results.
- Optimiser: the BRE 25° daylight constraint missed neighbours whose centre lay outside the scored area.
- Seasons follow the hemisphere; south of the equator the planning check's summer heat test reads December to February.
- A vs B for solar and comfort used other settings than the Analyze cards (period, efficiency, manual weather).
- Green View Index counted crowns and ground outside the ±45° field of view (up to 100 % under tall trees).
- Cut & fill *Balance* on a polygon smaller than a cell returned the highest point of the DEM.
- The profile DXF left out a building cut by the end of the section line.
- Large terrain maps failed to go to QGIS (their values were sent twice).
- Wind ratio at the east edge of the grid, and the GLB/HTML terrain texture half a cell off.
- Visibility *From selected building* looked out from the centre of the roof, whose own edge hid almost all the ground (0.1 % visible from a 96 m tower). It now maps the ground that sees any of eight points along the building's top edge, which is where the building can be seen from (48 % for the same tower).
- Without a weather file, the sun's clock time zone came from the computer or the longitude: a scene in Turkey analysed on a computer set to UTC used UTC+2. The nearest weather station of the bundled index now sets it (UTC+3).

### Changed
- Noise: the default road sound power is 82 dB(A)/m (Lden of a busy two-lane road at 50 km/h, CNOSSOS-EU), up from 78, which read about 64 dB at 10 m from such a road instead of about 68.
- Traffic dispersion: the default emission is 60 µg/(m·s) of NO2 per metre of a road with traffic 1 (a busy two-lane road), down from 450, which put the mean NO2 of a real city centre at 86 µg/m³ and many streets at the 400 µg/m³ cap.
- The page stays responsive during analyses: GPU work waits on a fence between adaptive batches of sky and sun directions, and the comfort, diurnal, Green View and dispersion loops yield with progress. Freezes of 13–40 s in a software-rendered test dropped to about 2–3 s.
- Traffic dispersion visits only the road sources within the 250 m plume reach (25 m bins, distant bins as one source): three times faster on a block grid, within 5 % of the full sum.
- Noise map: a second cluster level (32 m beyond 160 m) and distance-scaled ray steps for distant clusters: 2.4 times faster again, eleven times faster than tracing every road sample, within 0.5 dB of it.
- QGIS 4 (Qt6): `QAction` is imported from `QtGui`, with `QtWidgets` as the fallback for Qt5.
- The animated wind streamlines pause while an analysis runs. They redraw the whole scene every frame and stayed on after a wind map: the next analysis ran up to six times slower (thermal comfort after a wind map: 161 s instead of 24 s in a software-rendered test).

## [1.2.0] - 2026-10-26

### Added
- *Roads* layer role for QGIS line layers: the noise and air-quality maps use every visible Roads layer, with a per-road *Traffic* expression (1 = the level set in the viewer, 2 doubles the traffic, 0 leaves the road out; guessed from a `lanes` field).
- OpenStreetMap roads: *Download OSM buildings, trees & roads* also adds `osm_roads` with `traffic_weight` by `highway` class (motorway 8 … residential 0.4, links half, tunnels left out).
- Result subtitles name the road sources of a noise or dispersion run.
- Reference manual chapters for microclimate and PET, ventilation and air quality, environmental noise, and green view and the solar envelope; a GitHub-readable copy, `docs/MANUAL.md`, built from `docs/index.html` by `tools/build_manual_md.py`.

### Fixed
- The Analyze cards always passed the (usually empty) list of drawn roads, so QGIS line layers never reached the noise and dispersion maps, and the same buildings got other values in the planning check. Section lines are no longer used as roads.
- Noise map: three to ten times faster, with distant road samples grouped in 8 m clusters (within 0.5 dB of the full sum on a block grid), and computed with progress instead of freezing the page.
- Without roads, sources now follow the street centrelines between buildings as residential streets. Before, a band of parallel sources across every street saturated the pollution map at its 400 µg/m³ cap.
- Solar envelope: a building no longer limits itself through its own shadow, and sun that existing buildings already block sets no limit. An isolated block used to get an envelope of about 1 m.
- Surface temperature: the Bowen ratio now scales only the turbulent exchange, not the radiative one. Vegetated surfaces had been about 25 % too cool.
- Noise: air absorption at 500 Hz (1.9 dB/km, ISO 9613-2) to match the barrier frequency, and a 20 dB cap for single diffraction.
- Wind streamlines no longer draw a stray segment where a trace leaves the grid.
- The 24 h diurnal study uses the comfort card's manually entered temperature, humidity and wind, with clear-sky radiation, instead of fixed values.
- `PLUGIN_VERSION`, which is sent as the OSM user agent, was still 1.0.3.

## [1.1.0] - 2026-10-24

### Added
- Surface energy balance & microclimate physics (`surfaceTemperature`, `canopyCoolingGrid`, Bowen ratio partitioning, Leaf Area Index shading, and What-If interactive 3D tree planting).
- Physiological Equivalent Temperature (`pet`, MEMI energy balance) alongside UTCI, surface-aware Mean Radiant Temperature, and 24-hour animated diurnal thermal comfort studies (`diurnalStudy`).
- Street-canyon ventilation efficiency (`vei`), normalized air age (`airage`), and OSPM-inspired traffic pollutant dispersion (`dispersion`, NO2/PM2.5) with tree canopy filtration.
- 3D environmental noise propagation (`noise`, ISO 9613-2 / CNOSSOS-EU screening proxy with Maekawa barrier diffraction and quiet-facade detection).
- Pedestrian Green View Index (`gvi`) and Knowles / BRE 3D Solar Envelope (`solarenvelope`, `solarfloors`).
- Animated 3D wind streamlines (`WindStreamlines`), 24-hour point microclimate curves (`drawDiurnalChart`), and polar stereographic sun-path diagrams (`drawSunPathDiagram`) in the ground inspector.

## [1.0.3] - 2026-10-20

### Compatibility
- Full QGIS 4 and Qt6 compatibility: updated all QGIS enum references to scoped enum classes (`QgsAbstract3DSymbol.Property`, `QgsVectorFileWriter.WriterError`, `QgsVectorFileWriter.ActionOnExistingFile`, and `QgsBlockingNetworkRequest.ErrorCode`).

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
