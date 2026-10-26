// @ts-check
// Microclimate physics module: ENVI-met-inspired surface energy balance,
// foliar canopy shading, evapotranspirative canopy cooling advection,
// and 24-hour diurnal thermal comfort profiling.

import { skyTemperature, meanRadiantTemperature, utci, pet } from './comfort.js';
import { dayOfYear, solarPosition } from './solar.js';
import { conditionsAt } from './weather.js';

const SIGMA = 5.67e-8;

/**
 * Standard urban surface materials with thermal and radiative properties.
 * albedo: shortwave reflectance (0..1)
 * emissivity: thermal longwave emissivity (0..1)
 * bowen: Bowen ratio (sensible heat / latent heat flux)
 * roughness: aerodynamic roughness length z0 (m)
 * color: default hexadecimal color for 3D visualization
 */
export const SURFACE_MATERIALS = {
  asphalt: { label: 'Asphalt / dark pavement', albedo: 0.12, emissivity: 0.95, bowen: 8.0, roughness: 0.01, color: '#3b3d42' },
  concrete: { label: 'Concrete / stone', albedo: 0.28, emissivity: 0.92, bowen: 5.0, roughness: 0.015, color: '#a6acb5' },
  brick: { label: 'Brick / pavers', albedo: 0.25, emissivity: 0.93, bowen: 4.0, roughness: 0.02, color: '#b86b52' },
  soil: { label: 'Bare soil / gravel', albedo: 0.22, emissivity: 0.94, bowen: 2.0, roughness: 0.03, color: '#b59975' },
  grass: { label: 'Grass / vegetated ground', albedo: 0.22, emissivity: 0.97, bowen: 0.5, roughness: 0.05, color: '#6fbf73' },
  cool_pavement: { label: 'Cool pavement (high albedo)', albedo: 0.55, emissivity: 0.95, bowen: 5.0, roughness: 0.01, color: '#d8dee9' },
  green_roof: { label: 'Green / cool roof', albedo: 0.45, emissivity: 0.96, bowen: 0.6, roughness: 0.06, color: '#7fc97f' },
  water: { label: 'Water surface', albedo: 0.08, emissivity: 0.98, bowen: 0.25, roughness: 0.001, color: '#2b83ba' }
};

/**
 * Beer-Lambert shortwave foliar transmittance through vegetation canopy.
 * @param {number} [lai] leaf area index (m2 leaves / m2 ground, default 3.0)
 * @param {number} [extinction] light extinction coefficient k (default 0.6)
 * @returns {number} transmittance fraction (0..1)
 */
export function canopyTransmittance(lai = 3.0, extinction = 0.6) {
  return Math.exp(-extinction * Math.max(0, lai));
}

/**
 * Steady-state ground/roof surface temperature Ts (°C) via energy balance.
 * @param {object} p
 * @param {number} p.airTemp air temperature, °C
 * @param {number} p.skyTemp effective sky temperature, °C
 * @param {number} [p.svf] sky view factor (0..1, default 1)
 * @param {number|boolean} [p.sunlit] direct sun fraction (0..1, default 1)
 * @param {number} [p.dni] direct normal irradiance, W/m2
 * @param {number} [p.dhi] diffuse horizontal irradiance, W/m2
 * @param {number} [p.ghi] global horizontal irradiance, W/m2
 * @param {number} [p.elevationDeg] sun elevation angle, degrees (default 45)
 * @param {number} [p.windSpeed] near-surface wind speed, m/s (default 2)
 * @param {string|object} [p.material] material key in SURFACE_MATERIALS or property object
 * @param {number} [p.treeShade] canopy shading fraction (0..1, default 0)
 * @param {number} [p.lai] leaf area index of shading trees (default 3.0)
 * @returns {number} surface temperature, °C
 */
export function surfaceTemperature({
  airTemp,
  skyTemp,
  svf = 1,
  sunlit = 1,
  dni = 0,
  dhi = 0,
  ghi = 0,
  elevationDeg = 45,
  windSpeed = 2,
  material = 'concrete',
  treeShade = 0,
  lai = 3.0
}) {
  const mat = (typeof material === 'object' && material) ? material : (SURFACE_MATERIALS[material] || SURFACE_MATERIALS.concrete);
  const albedo = Number.isFinite(mat.albedo) ? mat.albedo : 0.28;
  const emissivity = Number.isFinite(mat.emissivity) ? mat.emissivity : 0.92;
  const bowen = Number.isFinite(mat.bowen) ? mat.bowen : 5.0;

  // Direct shortwave on horizontal surface
  let swDirect = elevationDeg > 0
    ? dni * Math.sin(elevationDeg * Math.PI / 180) * Math.max(0, Math.min(1, Number(sunlit)))
    : 0;

  // Attenuate direct beam if tree shade is present
  const shade = Math.max(0, Math.min(1, Number(treeShade)));
  if (shade > 0) {
    const tau = canopyTransmittance(lai);
    swDirect *= (1 - shade * (1 - tau));
  }

  const svfClamped = Math.max(0, Math.min(1, svf));
  const swDiffuse = svfClamped * dhi;
  const swAbsorbed = (1 - albedo) * (swDirect + swDiffuse);

  // Net longwave deficit to cold sky
  const tSkyK = skyTemp + 273.15;
  const tAirK = airTemp + 273.15;
  const lwNet = emissivity * svfClamped * SIGMA * (Math.pow(tSkyK, 4) - Math.pow(tAirK, 4));

  const qRad = swAbsorbed + lwNet;

  // Convective conductance and linearized radiative conductance
  const ws = Math.max(0.2, Math.min(15, Number.isFinite(windSpeed) ? windSpeed : 2));
  const hc = 5.8 + 4.1 * ws;
  const hr = 4 * emissivity * SIGMA * Math.pow(tAirK, 3);

  // qRad = H + LE + hr dT with H = hc dT and LE = H / beta (Bowen ratio), so
  // evaporation raises the convective conductance only, not the radiative
  // one. A surface losing heat (qRad < 0) does not evaporate.
  const hTurb = qRad > 0 ? hc * (1 + bowen) / bowen : hc;
  const deltaT = qRad / (hTurb + hr);
  const clampedDelta = Math.max(-12, Math.min(35, deltaT));

  return airTemp + clampedDelta;
}

/**
 * Evapotranspirative canopy cooling potential and downwind advection grid.
 * @param {object} p
 * @param {Float32Array} p.heights obstacle height above ground per cell (0 = open)
 * @param {Float32Array|null} [p.porosity] optical porosity per cell 0..1 (trees > 0), null = solid
 * @param {Float32Array|null} [p.greenMask] vegetated ground fraction 0..1 (grass/lawn)
 * @param {number} p.cols grid column count
 * @param {number} p.rows grid row count
 * @param {number} p.cell grid cell dimension in metres
 * @param {number} [p.windFromDeg] meteorological direction wind is coming from (degrees, 0 = N, 90 = E, 180 = S, 270 = W)
 * @param {number} [p.windSpeed] ambient wind speed, m/s (default 2)
 * @param {number} [p.airTemp] ambient air temperature, °C (default 30)
 * @param {number} [p.rh] relative humidity, % (default 45)
 * @param {number} [p.lai] tree leaf area index (default 3.0)
 * @param {Float32Array|null} [p.svf] sky view factor grid (0..1)
 * @returns {Float32Array} local air temperature modification dTa (°C, negative = cooling, positive = canyon heating; NaN inside solid buildings)
 */
export function canopyCoolingGrid({
  heights,
  porosity = null,
  greenMask = null,
  cols,
  rows,
  cell,
  windFromDeg = 270,
  windSpeed = 2,
  airTemp = 30,
  rh = 45,
  lai = 3.0,
  svf = null
}) {
  const n = cols * rows;
  const dTa = new Float32Array(n);
  const source = new Float32Array(n);

  // Evapotranspiration driving potential proportional to VPD and temperature above 10°C
  const vpdNorm = Math.max(0.1, Math.min(1.0, 1 - Math.max(0, Math.min(100, rh)) / 100));
  const tempExcess = Math.max(0, Math.min(1.5, (Math.max(15, airTemp) - 10) / 15));
  const vpdFactor = vpdNorm * tempExcess;

  // 1. Identify local evapotranspirative cooling source potential per cell
  for (let i = 0; i < n; i++) {
    const isSolidBuilding = heights[i] > 0 && !(porosity && porosity[i] > 0);
    if (isSolidBuilding) {
      source[i] = 0;
      continue;
    }

    let treeCool = 0;
    if (porosity && porosity[i] > 0) {
      // Tree canopy cell: cooling up to -2.5 °C for dense canopy (lai >= 3)
      const treeDensity = Math.min(1.0, Math.max(0, lai / 3.0));
      treeCool = -2.5 * vpdFactor * treeDensity;
    }

    let grassCool = 0;
    if (greenMask && greenMask[i] > 0) {
      // Vegetated ground cell: cooling up to -1.0 °C
      const grassDensity = Math.min(1.0, Math.max(0, greenMask[i]));
      grassCool = -1.0 * vpdFactor * grassDensity;
    }

    source[i] = Math.min(treeCool, grassCool);
  }

  // Unit vector pointing upwind (towards where the wind comes from):
  // +col is east (+x), -row is north (+y)
  const fromRad = windFromDeg * Math.PI / 180;
  const dc = Math.sin(fromRad);
  const dr = -Math.cos(fromRad);

  // Exponential downwind decay length (~30-50 m, scaled slightly with wind speed)
  const decay = Math.max(25, Math.min(60, 35 + windSpeed * 2.5));
  const maxSearchSteps = Math.ceil(120 / cell);

  // 2. Advect and diffuse cooling downwind and apply canyon heat increment
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const isSolidBuilding = heights[idx] > 0 && !(porosity && porosity[idx] > 0);
      if (isSolidBuilding) {
        dTa[idx] = NaN;
        continue;
      }

      // Local source cooling at cell
      let cellCooling = source[idx];

      // Trace upwind along the wind streamline to accumulate advected cooling
      let maxUpwindCooling = 0;
      for (let s = 1; s <= maxSearchSteps; s++) {
        const uc = Math.round(c + s * dc);
        const ur = Math.round(r + s * dr);
        if (uc < 0 || uc >= cols || ur < 0 || ur >= rows) break;
        const uidx = ur * cols + uc;
        // Solid obstacle blocks advection fetch
        if (heights[uidx] > 0 && !(porosity && porosity[uidx] > 0)) break;

        const upSource = source[uidx];
        if (upSource < 0) {
          const dist = s * cell;
          const advected = upSource * Math.exp(-dist / decay);
          if (advected < maxUpwindCooling) {
            maxUpwindCooling = advected;
          }
        }
      }

      // Total cooling modification
      const cooling = Math.min(cellCooling, maxUpwindCooling);

      // Urban canyon heat trapping increment in deep low-SVF canyons
      let uhiIncrement = 0;
      if (svf && Number.isFinite(svf[idx]) && svf[idx] < 0.5) {
        uhiIncrement = 1.5 * ((0.5 - svf[idx]) / 0.5);
      }

      dTa[idx] = cooling + uhiIncrement;
    }
  }

  return dTa;
}

/**
 * Compute 24-hour diurnal thermal comfort and surface temperature profile.
 * @param {object} p
 * @param {number} p.lat latitude in degrees
 * @param {number} p.lon longitude in degrees
 * @param {number} p.utcOffset UTC offset in hours
 * @param {number} p.month calendar month (1..12)
 * @param {number} p.day day of month (1..31)
 * @param {object|null} [p.weather] parsed EPW weather dataset from parseEpw()
 * @param {number} [p.airTempMean] daily mean air temperature if no weather dataset (°C, default 28)
 * @param {number} [p.airTempAmp] daily temperature amplitude if no weather dataset (°C, default 6)
 * @param {number} [p.rhMean] daily mean relative humidity if no weather dataset (%, default 50)
 * @param {number} [p.windSpeed] ambient wind speed (m/s, default 2)
 * @param {number} [p.svf] sky view factor of the spot (0..1, default 0.7)
 * @param {Array<number>|Function|null} [p.sunByHour] array or function returning sunlit fraction (0..1) per hour
 * @param {string|object} [p.material] surface material key or definition (default 'concrete')
 * @param {boolean} [p.treeCrown] whether spot is shaded by tree canopy (default false)
 * @param {number} [p.lai] leaf area index of shading trees (default 3.0)
 * @returns {Array<{ hour: number, airTemp: number, surfaceTemp: number, mrt: number, utci: number, pet: number, sunlit: number }>}
 */
export function diurnalPointProfile({
  lat,
  lon,
  utcOffset,
  month,
  day,
  weather = null,
  airTempMean = 28,
  airTempAmp = 6,
  rhMean = 50,
  windSpeed = 2,
  svf = 0.7,
  sunByHour = null,
  material = 'concrete',
  treeCrown = false,
  lai = 3.0
}) {
  const mat = (typeof material === 'object' && material) ? material : (SURFACE_MATERIALS[material] || SURFACE_MATERIALS.concrete);
  const doy = dayOfYear(2025, month, day);
  const profile = [];

  for (let h = 0; h < 24; h++) {
    const pos = solarPosition(doy, h + 0.5, lat, lon, utcOffset);
    const elevationDeg = pos.elevation * 180 / Math.PI;

    let airTemp = airTempMean;
    let rh = rhMean;
    let ws = windSpeed;
    let dni = 0;
    let dhi = 0;
    let ghi = 0;
    let ir = null;

    if (weather) {
      const cond = conditionsAt(weather, month, day, h + 1);
      if (Number.isFinite(cond.airTemp)) airTemp = cond.airTemp;
      if (Number.isFinite(cond.rh)) rh = cond.rh;
      if (Number.isFinite(cond.windSpeed)) ws = cond.windSpeed;
      if (Number.isFinite(cond.dni)) dni = cond.dni;
      if (Number.isFinite(cond.dhi)) dhi = cond.dhi;
      if (Number.isFinite(cond.ghi)) ghi = cond.ghi;
      if (Number.isFinite(cond.ir)) ir = cond.ir;
    } else {
      // Sinusoidal diurnal temperature wave with peak at 15:00
      airTemp = airTempMean + airTempAmp * Math.cos((h - 15) * Math.PI / 12);
      // Inverted diurnal relative humidity wave with minimum at 15:00
      rh = Math.max(20, Math.min(95, rhMean - 15 * Math.cos((h - 15) * Math.PI / 12)));
      ws = windSpeed;

      if (elevationDeg > 0) {
        const sinElev = Math.sin(pos.elevation);
        dni = 950 * Math.exp(-0.13 / Math.max(0.01, sinElev));
        dhi = 120 * sinElev;
        ghi = dni * sinElev + dhi;
      }
    }

    // Determine sunlit fraction for this hour
    let isSunlit = elevationDeg > 0 ? 1 : 0;
    if (sunByHour !== null) {
      if (typeof sunByHour === 'function') {
        isSunlit = Number(sunByHour(h));
      } else if (Array.isArray(sunByHour) && Number.isFinite(sunByHour[h])) {
        isSunlit = Number(sunByHour[h]);
      }
    }

    const skyTemp = skyTemperature(airTemp, ir);

    const surfaceTemp = surfaceTemperature({
      airTemp,
      skyTemp,
      svf,
      sunlit: isSunlit,
      dni,
      dhi,
      ghi,
      elevationDeg,
      windSpeed: ws,
      material: mat,
      treeShade: treeCrown ? 1 : 0,
      lai
    });

    const mrt = meanRadiantTemperature({
      airTemp,
      skyTemp,
      svf,
      sunlit: isSunlit,
      dni,
      dhi,
      ghi,
      elevationDeg,
      albedo: mat.albedo,
      groundTemp: surfaceTemp,
      wallTemp: airTemp
    });

    const utciVal = utci(airTemp, mrt, ws, rh);
    const petVal = pet(airTemp, mrt, ws, rh);

    profile.push({
      hour: h,
      airTemp,
      surfaceTemp,
      mrt,
      utci: utciVal,
      pet: petVal,
      sunlit: isSunlit
    });
  }

  return profile;
}
