# Viewer end-to-end checks

Headless runs of every tool through the real viewer UI. They need Node.js and
Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`);
nothing here ships in the plugin zip.

```
py -3 tests/make_demo_scene.py demo_scene
py -3 tests/e2e/prepare_demo.py demo_scene path/to/weather.epw   # roads + EPW (EPW optional)
py -3 tests/serve_demo.py demo_scene                               # http://127.0.0.1:8660/...
node tests/e2e/viewer_sweep.cjs                                    # every Analyze, Terrain and Compare action
node tests/e2e/viewer_extras.cjs                                   # selected building, exports, offline HTML, To QGIS
node tests/e2e/viewer_extras2.cjs                                  # shadow study, compare panels, video, section files
```

`viewer_sweep.cjs [url] [regex]` runs only the actions whose label matches the
regex, e.g. `"Acoustic|Canyon"`. Each result is checked for empty, flat or NaN
values; the summary lists the run time and the longest main-thread freeze of
every action. The sweep exits with 1 when an action fails or logs an error.

Without a GPU, Chromium renders in software (SwiftShader): runs are several
times slower than on a real GPU and freezes look longer than they are.
