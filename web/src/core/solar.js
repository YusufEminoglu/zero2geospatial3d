// @ts-check
// Solar geometry (NOAA "General Solar Position Calculations"), sun-path
// sampling for one day, and sky sampling for sky view / diffuse light.
//
// Scene axes: +x east, +y up, -z north. Azimuth is clockwise from north.

const DEG = Math.PI / 180;

/** Day of year (1..366) for a calendar date. */
export function dayOfYear(year, month, day) {
  const start = Date.UTC(year, 0, 1);
  return Math.floor((Date.UTC(year, month - 1, day) - start) / 86400000) + 1;
}

export function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Sun position.
 * @param {number} doy day of year (1-based)
 * @param {number} hour local clock time in hours (0..24, fractional)
 * @param {number} lat latitude, degrees north
 * @param {number} lon longitude, degrees east
 * @param {number} utcOffset time zone of the clock, hours east of UTC
 * @param {number} [daysInYear]
 * @returns {{ elevation: number, azimuth: number, declination: number, eqTime: number }}
 *   elevation and azimuth in radians (azimuth clockwise from north), eqTime minutes
 */
export function solarPosition(doy, hour, lat, lon, utcOffset, daysInYear = 365) {
  // The fractional year is defined on UTC time.
  const g = (2 * Math.PI / daysInYear) * (doy - 1 + (hour - utcOffset - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const trueSolarMinutes = hour * 60 + eqTime + 4 * lon - 60 * utcOffset;
  const ha = (trueSolarMinutes / 4 - 180) * DEG;
  const phi = lat * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  let azimuth = Math.atan2(-Math.sin(ha) * Math.cos(decl),
    Math.cos(phi) * Math.sin(decl) - Math.sin(phi) * Math.cos(decl) * Math.cos(ha));
  if (azimuth < 0) azimuth += 2 * Math.PI;
  return { elevation, azimuth, declination: decl, eqTime };
}

/** Unit vector towards the sun in scene axes. */
export function sunVector(elevation, azimuth) {
  const c = Math.cos(elevation);
  return [Math.sin(azimuth) * c, Math.sin(elevation), -Math.cos(azimuth) * c];
}

/** Clock hours of sunrise and sunset (elevation crosses 0), or null for polar day/night. */
export function sunriseSunset(doy, lat, lon, utcOffset) {
  const above = (h) => solarPosition(doy, h, lat, lon, utcOffset).elevation > 0;
  const step = 0.25;
  let rise = null;
  let set = null;
  for (let h = 0; h < 24; h += step) {
    const a = above(h);
    const b = above(h + step);
    if (!a && b && rise === null) rise = bisect(above, h, h + step, false);
    if (a && !b) set = bisect(above, h, h + step, true);
  }
  return { sunrise: rise, sunset: set };
}

function bisect(above, lo, hi, startAbove) {
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (above(mid) === startAbove) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Sun directions through one day, every stepMinutes between startHour and
 * endHour while the sun is above minElevationDeg. Each sample is weighted
 * with its duration in hours, so the weights of unobstructed samples sum to
 * sun hours.
 */
export function sunPath(doy, lat, lon, utcOffset, { startHour = 0, endHour = 24, stepMinutes = 10, minElevationDeg = 0.5 } = {}) {
  const out = [];
  const step = stepMinutes / 60;
  for (let h = startHour + step / 2; h < endHour; h += step) {
    const p = solarPosition(doy, h, lat, lon, utcOffset);
    if (p.elevation < minElevationDeg * DEG) continue;
    out.push({ dir: sunVector(p.elevation, p.azimuth), weight: step, hour: h, elevation: p.elevation, azimuth: p.azimuth });
  }
  return out;
}

/**
 * Quasi-uniform directions over the upper hemisphere (Fibonacci lattice),
 * each standing for an equal solid angle 2*pi/n. With the shader's cosine
 * factor max(0, n.d) and weight 2/n, the sum is the sky view factor of a
 * surface with normal n: 1 for an open horizontal surface, 0.5 for an open
 * wall.
 */
export function skyHemisphere(n = 192) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n; // uniform in cos(zenith) = uniform solid angle
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    out.push({ dir: [Math.cos(a) * r, y, Math.sin(a) * r], weight: 2 / n });
  }
  return out;
}
