# Third-party notices

02 Geo3D Analyzer ships or derives from the following works.

## Three.js r160

Source: <https://github.com/mrdoob/three.js>

The MIT License

Copyright © 2010-2023 Three.js Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Files: `web/vendor/three/three.module.js`, `web/vendor/three/addons/controls/OrbitControls.js`.

## pythermalcomfort (UTCI polynomial)

Source: <https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort>, `models/utci.py`.
The UTCI regression polynomial and the saturation vapour pressure function in
`web/src/core/comfort.js` are transcribed from it. The polynomial itself is the
operational approximation of Bröde et al. (2012), Int J Biometeorol 56:481-494,
doi:10.1007/s00484-011-0454-1.

MIT License, Copyright (c) 2019 Federico Tartarini. The full MIT text is the
same as the one above, with that copyright line.

## climate.onebuilding.org station index

`data/epw_stations.json.gz` lists station names, coordinates, time zones,
elevations and download paths taken from the TMYx location indexes published
at <https://climate.onebuilding.org/> (built with `tools/build_epw_index.py`).
Weather files are downloaded from that site at the user's request; they are
not bundled. Credit: Climate.OneBuilding.Org.
