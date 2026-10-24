// @ts-check
// Outdoor thermal comfort: UTCI and mean radiant temperature.
//
// UTCI: the 6th-order polynomial approximation of Broede et al. (2012),
// "Deriving the operational procedure for the Universal Thermal Climate
// Index (UTCI)", Int J Biometeorol 56:481-494, doi:10.1007/s00484-011-0454-1.
// The polynomial and the saturation vapour pressure function are transcribed
// from pythermalcomfort (models/utci.py), MIT License, Copyright (c) 2019
// Federico Tartarini, and checked against its documented values
// (utci(25, 25, 1.0, 50) = 24.6; utci(40, 25, 1.0, 50) = 40.4).
//
// MRT: longwave exchange with sky and surroundings plus the SolarCal
// short-wave increment (Arens et al. 2015, "Modeling the comfort effects of
// short-wave solar radiation indoors", Building and Environment 88:3-9,
// doi:10.1016/j.buildenv.2014.09.004; ANSI/ASHRAE Standard 55, Appendix C).
// Surrounding surfaces are taken at air temperature: a screening model, not
// a surface energy balance.

const SIGMA = 5.67e-8;

/** Saturation vapour pressure over water, hPa (as used by the UTCI reference code). */
export function saturationVapourPressure(tdb) {
  const g = [-2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056e-10, -1.8680009e-13];
  const tk = tdb + 273.15;
  let es = 2.7150305 * Math.log(tk);
  for (let i = 0; i < g.length; i++) es += g[i] * Math.pow(tk, i - 2);
  return Math.exp(es) * 0.01;
}

/**
 * UTCI equivalent temperature, degrees C.
 * @param {number} tdb air temperature, C
 * @param {number} tr mean radiant temperature, C
 * @param {number} v wind speed at 10 m, m/s
 * @param {number} rh relative humidity, %
 * @param {{ limit?: boolean }} [opts] limit: NaN outside the model's validity range
 */
export function utci(tdb, tr, v, rh, { limit = false } = {}) {
  if (limit && (tdb < -50 || tdb > 50 || tr - tdb < -30 || tr - tdb > 70 || v < 0.5 || v > 17)) return NaN;
  const pa = saturationVapourPressure(tdb) * (rh / 100) / 10; // kPa
  const delta_t_tr = tr - tdb;
  return (
    tdb
    + 0.607562052
    + (-0.0227712343) * tdb
    + (8.06470249 * (10 ** (-4))) * tdb * tdb
    + (-1.54271372 * (10 ** (-4))) * tdb * tdb * tdb
    + (-3.24651735 * (10 ** (-6))) * tdb * tdb * tdb * tdb
    + (7.32602852 * (10 ** (-8))) * tdb * tdb * tdb * tdb * tdb
    + (1.35959073 * (10 ** (-9))) * tdb * tdb * tdb * tdb * tdb * tdb
    + (-2.25836520) * v
    + 0.0880326035 * tdb * v
    + 0.00216844454 * tdb * tdb * v
    + (-1.53347087 * (10 ** (-5))) * tdb * tdb * tdb * v
    + (-5.72983704 * (10 ** (-7))) * tdb * tdb * tdb * tdb * v
    + (-2.55090145 * (10 ** (-9))) * tdb * tdb * tdb * tdb * tdb * v
    + (-0.751269505) * v * v
    + (-0.00408350271) * tdb * v * v
    + (-5.21670675 * (10 ** (-5))) * tdb * tdb * v * v
    + (1.94544667 * (10 ** (-6))) * tdb * tdb * tdb * v * v
    + (1.14099531 * (10 ** (-8))) * tdb * tdb * tdb * tdb * v * v
    + 0.158137256 * v * v * v
    + (-6.57263143 * (10 ** (-5))) * tdb * v * v * v
    + (2.22697524 * (10 ** (-7))) * tdb * tdb * v * v * v
    + (-4.16117031 * (10 ** (-8))) * tdb * tdb * tdb * v * v * v
    + (-0.0127762753) * v * v * v * v
    + (9.66891875 * (10 ** (-6))) * tdb * v * v * v * v
    + (2.52785852 * (10 ** (-9))) * tdb * tdb * v * v * v * v
    + (4.56306672 * (10 ** (-4))) * v * v * v * v * v
    + (-1.74202546 * (10 ** (-7))) * tdb * v * v * v * v * v
    + (-5.91491269 * (10 ** (-6))) * v * v * v * v * v * v
    + 0.398374029 * delta_t_tr
    + (1.83945314 * (10 ** (-4))) * tdb * delta_t_tr
    + (-1.73754510 * (10 ** (-4))) * tdb * tdb * delta_t_tr
    + (-7.60781159 * (10 ** (-7))) * tdb * tdb * tdb * delta_t_tr
    + (3.77830287 * (10 ** (-8))) * tdb * tdb * tdb * tdb * delta_t_tr
    + (5.43079673 * (10 ** (-10))) * tdb * tdb * tdb * tdb * tdb * delta_t_tr
    + (-0.0200518269) * v * delta_t_tr
    + (8.92859837 * (10 ** (-4))) * tdb * v * delta_t_tr
    + (3.45433048 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr
    + (-3.77925774 * (10 ** (-7))) * tdb * tdb * tdb * v * delta_t_tr
    + (-1.69699377 * (10 ** (-9))) * tdb * tdb * tdb * tdb * v * delta_t_tr
    + (1.69992415 * (10 ** (-4))) * v * v * delta_t_tr
    + (-4.99204314 * (10 ** (-5))) * tdb * v * v * delta_t_tr
    + (2.47417178 * (10 ** (-7))) * tdb * tdb * v * v * delta_t_tr
    + (1.07596466 * (10 ** (-8))) * tdb * tdb * tdb * v * v * delta_t_tr
    + (8.49242932 * (10 ** (-5))) * v * v * v * delta_t_tr
    + (1.35191328 * (10 ** (-6))) * tdb * v * v * v * delta_t_tr
    + (-6.21531254 * (10 ** (-9))) * tdb * tdb * v * v * v * delta_t_tr
    + (-4.99410301 * (10 ** (-6))) * v * v * v * v * delta_t_tr
    + (-1.89489258 * (10 ** (-8))) * tdb * v * v * v * v * delta_t_tr
    + (8.15300114 * (10 ** (-8))) * v * v * v * v * v * delta_t_tr
    + (7.55043090 * (10 ** (-4))) * delta_t_tr * delta_t_tr
    + (-5.65095215 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr
    + (-4.52166564 * (10 ** (-7))) * tdb * tdb * delta_t_tr * delta_t_tr
    + (2.46688878 * (10 ** (-8))) * tdb * tdb * tdb * delta_t_tr * delta_t_tr
    + (2.42674348 * (10 ** (-10))) * tdb * tdb * tdb * tdb * delta_t_tr * delta_t_tr
    + (1.54547250 * (10 ** (-4))) * v * delta_t_tr * delta_t_tr
    + (5.24110970 * (10 ** (-6))) * tdb * v * delta_t_tr * delta_t_tr
    + (-8.75874982 * (10 ** (-8))) * tdb * tdb * v * delta_t_tr * delta_t_tr
    + (-1.50743064 * (10 ** (-9))) * tdb * tdb * tdb * v * delta_t_tr * delta_t_tr
    + (-1.56236307 * (10 ** (-5))) * v * v * delta_t_tr * delta_t_tr
    + (-1.33895614 * (10 ** (-7))) * tdb * v * v * delta_t_tr * delta_t_tr
    + (2.49709824 * (10 ** (-9))) * tdb * tdb * v * v * delta_t_tr * delta_t_tr
    + (6.51711721 * (10 ** (-7))) * v * v * v * delta_t_tr * delta_t_tr
    + (1.94960053 * (10 ** (-9))) * tdb * v * v * v * delta_t_tr * delta_t_tr
    + (-1.00361113 * (10 ** (-8))) * v * v * v * v * delta_t_tr * delta_t_tr
    + (-1.21206673 * (10 ** (-5))) * delta_t_tr * delta_t_tr * delta_t_tr
    + (-2.18203660 * (10 ** (-7))) * tdb * delta_t_tr * delta_t_tr * delta_t_tr
    + (7.51269482 * (10 ** (-9))) * tdb * tdb * delta_t_tr * delta_t_tr * delta_t_tr
    + (9.79063848 * (10 ** (-11)))
    * tdb
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.25006734 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (-1.81584736 * (10 ** (-9))) * tdb * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (-3.52197671 * (10 ** (-10)))
    * tdb
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-3.36514630 * (10 ** (-8))) * v * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (1.35908359 * (10 ** (-10)))
    * tdb
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.17032620 * (10 ** (-10)))
    * v
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-1.30369025 * (10 ** (-9)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.13908461 * (10 ** (-10)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (9.22652254 * (10 ** (-12)))
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-5.08220384 * (10 ** (-9)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-2.24730961 * (10 ** (-11)))
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.17139133 * (10 ** (-10)))
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (6.62154879 * (10 ** (-10)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.03863260 * (10 ** (-13)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.95087203 * (10 ** (-12)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-4.73602469 * (10 ** (-12)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + 5.12733497 * pa
    + (-0.312788561) * tdb * pa
    + (-0.0196701861) * tdb * tdb * pa
    + (9.99690870 * (10 ** (-4))) * tdb * tdb * tdb * pa
    + (9.51738512 * (10 ** (-6))) * tdb * tdb * tdb * tdb * pa
    + (-4.66426341 * (10 ** (-7))) * tdb * tdb * tdb * tdb * tdb * pa
    + 0.548050612 * v * pa
    + (-0.00330552823) * tdb * v * pa
    + (-0.00164119440) * tdb * tdb * v * pa
    + (-5.16670694 * (10 ** (-6))) * tdb * tdb * tdb * v * pa
    + (9.52692432 * (10 ** (-7))) * tdb * tdb * tdb * tdb * v * pa
    + (-0.0429223622) * v * v * pa
    + 0.00500845667 * tdb * v * v * pa
    + (1.00601257 * (10 ** (-6))) * tdb * tdb * v * v * pa
    + (-1.81748644 * (10 ** (-6))) * tdb * tdb * tdb * v * v * pa
    + (-1.25813502 * (10 ** (-3))) * v * v * v * pa
    + (-1.79330391 * (10 ** (-4))) * tdb * v * v * v * pa
    + (2.34994441 * (10 ** (-6))) * tdb * tdb * v * v * v * pa
    + (1.29735808 * (10 ** (-4))) * v * v * v * v * pa
    + (1.29064870 * (10 ** (-6))) * tdb * v * v * v * v * pa
    + (-2.28558686 * (10 ** (-6))) * v * v * v * v * v * pa
    + (-0.0369476348) * delta_t_tr * pa
    + 0.00162325322 * tdb * delta_t_tr * pa
    + (-3.14279680 * (10 ** (-5))) * tdb * tdb * delta_t_tr * pa
    + (2.59835559 * (10 ** (-6))) * tdb * tdb * tdb * delta_t_tr * pa
    + (-4.77136523 * (10 ** (-8))) * tdb * tdb * tdb * tdb * delta_t_tr * pa
    + (8.64203390 * (10 ** (-3))) * v * delta_t_tr * pa
    + (-6.87405181 * (10 ** (-4))) * tdb * v * delta_t_tr * pa
    + (-9.13863872 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr * pa
    + (5.15916806 * (10 ** (-7))) * tdb * tdb * tdb * v * delta_t_tr * pa
    + (-3.59217476 * (10 ** (-5))) * v * v * delta_t_tr * pa
    + (3.28696511 * (10 ** (-5))) * tdb * v * v * delta_t_tr * pa
    + (-7.10542454 * (10 ** (-7))) * tdb * tdb * v * v * delta_t_tr * pa
    + (-1.24382300 * (10 ** (-5))) * v * v * v * delta_t_tr * pa
    + (-7.38584400 * (10 ** (-9))) * tdb * v * v * v * delta_t_tr * pa
    + (2.20609296 * (10 ** (-7))) * v * v * v * v * delta_t_tr * pa
    + (-7.32469180 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa
    + (-1.87381964 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr * pa
    + (4.80925239 * (10 ** (-6))) * tdb * tdb * delta_t_tr * delta_t_tr * pa
    + (-8.75492040 * (10 ** (-8))) * tdb * tdb * tdb * delta_t_tr * delta_t_tr * pa
    + (2.77862930 * (10 ** (-5))) * v * delta_t_tr * delta_t_tr * pa
    + (-5.06004592 * (10 ** (-6))) * tdb * v * delta_t_tr * delta_t_tr * pa
    + (1.14325367 * (10 ** (-7))) * tdb * tdb * v * delta_t_tr * delta_t_tr * pa
    + (2.53016723 * (10 ** (-6))) * v * v * delta_t_tr * delta_t_tr * pa
    + (-1.72857035 * (10 ** (-8))) * tdb * v * v * delta_t_tr * delta_t_tr * pa
    + (-3.95079398 * (10 ** (-8))) * v * v * v * delta_t_tr * delta_t_tr * pa
    + (-3.59413173 * (10 ** (-7))) * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (7.04388046 * (10 ** (-7))) * tdb * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (-1.89309167 * (10 ** (-8)))
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-4.79768731 * (10 ** (-7))) * v * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (7.96079978 * (10 ** (-9)))
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (1.62897058 * (10 ** (-9)))
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (3.94367674 * (10 ** (-8)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-1.18566247 * (10 ** (-9)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (3.34678041 * (10 ** (-10)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-1.15606447 * (10 ** (-10)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-2.80626406) * pa * pa
    + 0.548712484 * tdb * pa * pa
    + (-0.00399428410) * tdb * tdb * pa * pa
    + (-9.54009191 * (10 ** (-4))) * tdb * tdb * tdb * pa * pa
    + (1.93090978 * (10 ** (-5))) * tdb * tdb * tdb * tdb * pa * pa
    + (-0.308806365) * v * pa * pa
    + 0.0116952364 * tdb * v * pa * pa
    + (4.95271903 * (10 ** (-4))) * tdb * tdb * v * pa * pa
    + (-1.90710882 * (10 ** (-5))) * tdb * tdb * tdb * v * pa * pa
    + 0.00210787756 * v * v * pa * pa
    + (-6.98445738 * (10 ** (-4))) * tdb * v * v * pa * pa
    + (2.30109073 * (10 ** (-5))) * tdb * tdb * v * v * pa * pa
    + (4.17856590 * (10 ** (-4))) * v * v * v * pa * pa
    + (-1.27043871 * (10 ** (-5))) * tdb * v * v * v * pa * pa
    + (-3.04620472 * (10 ** (-6))) * v * v * v * v * pa * pa
    + 0.0514507424 * delta_t_tr * pa * pa
    + (-0.00432510997) * tdb * delta_t_tr * pa * pa
    + (8.99281156 * (10 ** (-5))) * tdb * tdb * delta_t_tr * pa * pa
    + (-7.14663943 * (10 ** (-7))) * tdb * tdb * tdb * delta_t_tr * pa * pa
    + (-2.66016305 * (10 ** (-4))) * v * delta_t_tr * pa * pa
    + (2.63789586 * (10 ** (-4))) * tdb * v * delta_t_tr * pa * pa
    + (-7.01199003 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr * pa * pa
    + (-1.06823306 * (10 ** (-4))) * v * v * delta_t_tr * pa * pa
    + (3.61341136 * (10 ** (-6))) * tdb * v * v * delta_t_tr * pa * pa
    + (2.29748967 * (10 ** (-7))) * v * v * v * delta_t_tr * pa * pa
    + (3.04788893 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa * pa
    + (-6.42070836 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr * pa * pa
    + (1.16257971 * (10 ** (-6))) * tdb * tdb * delta_t_tr * delta_t_tr * pa * pa
    + (7.68023384 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * pa * pa
    + (-5.47446896 * (10 ** (-7))) * tdb * v * delta_t_tr * delta_t_tr * pa * pa
    + (-3.59937910 * (10 ** (-8))) * v * v * delta_t_tr * delta_t_tr * pa * pa
    + (-4.36497725 * (10 ** (-6))) * delta_t_tr * delta_t_tr * delta_t_tr * pa * pa
    + (1.68737969 * (10 ** (-7)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (2.67489271 * (10 ** (-8)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (3.23926897 * (10 ** (-9)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (-0.0353874123) * pa * pa * pa
    + (-0.221201190) * tdb * pa * pa * pa
    + 0.0155126038 * tdb * tdb * pa * pa * pa
    + (-2.63917279 * (10 ** (-4))) * tdb * tdb * tdb * pa * pa * pa
    + 0.0453433455 * v * pa * pa * pa
    + (-0.00432943862) * tdb * v * pa * pa * pa
    + (1.45389826 * (10 ** (-4))) * tdb * tdb * v * pa * pa * pa
    + (2.17508610 * (10 ** (-4))) * v * v * pa * pa * pa
    + (-6.66724702 * (10 ** (-5))) * tdb * v * v * pa * pa * pa
    + (3.33217140 * (10 ** (-5))) * v * v * v * pa * pa * pa
    + (-0.00226921615) * delta_t_tr * pa * pa * pa
    + (3.80261982 * (10 ** (-4))) * tdb * delta_t_tr * pa * pa * pa
    + (-5.45314314 * (10 ** (-9))) * tdb * tdb * delta_t_tr * pa * pa * pa
    + (-7.96355448 * (10 ** (-4))) * v * delta_t_tr * pa * pa * pa
    + (2.53458034 * (10 ** (-5))) * tdb * v * delta_t_tr * pa * pa * pa
    + (-6.31223658 * (10 ** (-6))) * v * v * delta_t_tr * pa * pa * pa
    + (3.02122035 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa * pa * pa
    + (-4.77403547 * (10 ** (-6))) * tdb * delta_t_tr * delta_t_tr * pa * pa * pa
    + (1.73825715 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * pa * pa * pa
    + (-4.09087898 * (10 ** (-7)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    * pa
    + 0.614155345 * pa * pa * pa * pa
    + (-0.0616755931) * tdb * pa * pa * pa * pa
    + 0.00133374846 * tdb * tdb * pa * pa * pa * pa
    + 0.00355375387 * v * pa * pa * pa * pa
    + (-5.13027851 * (10 ** (-4))) * tdb * v * pa * pa * pa * pa
    + (1.02449757 * (10 ** (-4))) * v * v * pa * pa * pa * pa
    + (-0.00148526421) * delta_t_tr * pa * pa * pa * pa
    + (-4.11469183 * (10 ** (-5))) * tdb * delta_t_tr * pa * pa * pa * pa
    + (-6.80434415 * (10 ** (-6))) * v * delta_t_tr * pa * pa * pa * pa
    + (-9.77675906 * (10 ** (-6))) * delta_t_tr * delta_t_tr * pa * pa * pa * pa
    + 0.0882773108 * pa * pa * pa * pa * pa
    + (-0.00301859306) * tdb * pa * pa * pa * pa * pa
    + 0.00104452989 * v * pa * pa * pa * pa * pa
    + (2.47090539 * (10 ** (-4))) * delta_t_tr * pa * pa * pa * pa * pa
    + 0.00148348065 * pa * pa * pa * pa * pa * pa
  );
}

export const UTCI_CATEGORIES = [
  { max: -40, label: 'Extreme cold stress', color: '#08306b' },
  { max: -27, label: 'Very strong cold stress', color: '#08519c' },
  { max: -13, label: 'Strong cold stress', color: '#2171b5' },
  { max: 0, label: 'Moderate cold stress', color: '#6baed6' },
  { max: 9, label: 'Slight cold stress', color: '#c6dbef' },
  { max: 26, label: 'No thermal stress', color: '#a1d99b' },
  { max: 32, label: 'Moderate heat stress', color: '#fdd0a2' },
  { max: 38, label: 'Strong heat stress', color: '#fd8d3c' },
  { max: 46, label: 'Very strong heat stress', color: '#d94801' },
  { max: Infinity, label: 'Extreme heat stress', color: '#7f2704' }
];

export function utciCategory(value) {
  if (!Number.isFinite(value)) return null;
  return UTCI_CATEGORIES.find((c) => value < c.max) || UTCI_CATEGORIES[UTCI_CATEGORIES.length - 1];
}

/**
 * Projected area factor of a standing person for a sun elevation in degrees
 * (Underwood and Ward 1966, as used by SOLWEIG): projected area over the
 * effective radiating area.
 */
export function projectedAreaFactor(elevationDeg) {
  const b = Math.max(0, Math.min(90, elevationDeg));
  return 0.308 * Math.cos((b * (0.998 - (b * b) / 50000)) * Math.PI / 180);
}

/** Sky temperature (C) from EPW horizontal infrared, or Swinbank (1963) when missing. */
export function skyTemperature(airTemp, horizontalIr) {
  if (Number.isFinite(horizontalIr) && horizontalIr > 50) return Math.pow(horizontalIr / SIGMA, 0.25) - 273.15;
  const ta = airTemp + 273.15;
  return 0.0552 * Math.pow(ta, 1.5) - 273.15;
}

/**
 * Mean radiant temperature of a standing person outdoors, C.
 * @param {object} p
 * @param {number} p.airTemp C
 * @param {number} p.skyTemp C
 * @param {number} p.svf sky view factor of the spot (0..1)
 * @param {boolean|number} p.sunlit 1 if the person is in the sun (fraction allowed)
 * @param {number} p.dni direct normal irradiance, W/m2
 * @param {number} p.dhi diffuse horizontal irradiance, W/m2
 * @param {number} p.ghi global horizontal irradiance, W/m2
 * @param {number} p.elevationDeg sun elevation, degrees
 * @param {number} [p.albedo] ground reflectance
 * @param {number} [p.absorptivity] clothing/skin short-wave absorptivity
 * @param {number} [p.groundTemp] ground surface temperature, C
 * @param {number} [p.wallTemp] surrounding wall temperature, C
 */
export function meanRadiantTemperature({
  airTemp,
  skyTemp,
  svf,
  sunlit,
  dni,
  dhi,
  ghi,
  elevationDeg,
  albedo = 0.2,
  absorptivity = 0.7,
  groundTemp = NaN,
  wallTemp = NaN
}) {
  const fEff = 0.725;      // standing person
  const hr = 6.012;        // W/m2K
  const emissivity = 0.95; // long-wave absorptivity
  const s = Math.max(0, Math.min(1, svf));
  const tSky = skyTemp + 273.15;
  const tAir = airTemp + 273.15;

  let tLw;
  if (!Number.isFinite(groundTemp) && !Number.isFinite(wallTemp)) {
    // Exact backward-compatible formula when surface temperatures are omitted
    const fSky = 0.5 * s;
    tLw = Math.pow(fSky * Math.pow(tSky, 4) + (1 - fSky) * Math.pow(tAir, 4), 0.25) - 273.15;
  } else {
    // Surface-aware longwave exchange:
    // Upper hemisphere (weight 0.5) has svf sky at tSky and (1 - svf) walls at tWall.
    // Lower hemisphere (weight 0.5) is ground at tGnd.
    const tWall = (Number.isFinite(wallTemp) ? wallTemp : airTemp) + 273.15;
    const tGnd = (Number.isFinite(groundTemp) ? groundTemp : airTemp) + 273.15;
    tLw = Math.pow(0.5 * s * Math.pow(tSky, 4) + 0.5 * (1 - s) * Math.pow(tWall, 4) + 0.5 * Math.pow(tGnd, 4), 0.25) - 273.15;
  }

  if (!(elevationDeg > 0) || !(ghi > 0)) return tLw;
  const fBes = Math.max(0, Math.min(1, Number(sunlit)));
  const apOverAd = projectedAreaFactor(elevationDeg) * fEff;
  const eDiff = 0.5 * fEff * s * (dhi + ghi * albedo);
  const eDir = apOverAd * fBes * dni;
  const erf = (eDiff + eDir) * (absorptivity / emissivity);
  return tLw + erf / (fEff * hr);
}

export const PET_CATEGORIES = [
  { max: 4, label: 'Extreme cold stress', color: '#08306b' },
  { max: 8, label: 'Strong cold stress', color: '#2171b5' },
  { max: 13, label: 'Moderate cold stress', color: '#6baed6' },
  { max: 18, label: 'Slight cold stress', color: '#c6dbef' },
  { max: 23, label: 'Comfortable', color: '#a1d99b' },
  { max: 29, label: 'Slight heat stress', color: '#fdd0a2' },
  { max: 35, label: 'Moderate heat stress', color: '#fd8d3c' },
  { max: 41, label: 'Strong heat stress', color: '#d94801' },
  { max: Infinity, label: 'Extreme heat stress', color: '#7f2704' }
];

/**
 * Return thermal stress category for a PET value (°C).
 * @param {number} value
 * @returns {{ max: number, label: string, color: string } | null}
 */
export function petCategory(value) {
  if (!Number.isFinite(value)) return null;
  return PET_CATEGORIES.find((c) => value < c.max) || PET_CATEGORIES[PET_CATEGORIES.length - 1];
}

/**
 * Physiological Equivalent Temperature (PET) following Höppe (1999) / Walther & Goestchel (2018) MEMI.
 * @param {number} tdb dry-bulb air temperature, C
 * @param {number} tr mean radiant temperature, C
 * @param {number} v wind speed, m/s
 * @param {number} rh relative humidity, %
 * @param {{ met?: number, clo?: number }} [opts] met in W (default 80), clo (default 0.9)
 * @returns {number} PET in degrees C
 */
export function pet(tdb, tr, v, rh, { met = 80, clo = 0.9 } = {}) {
  if (!Number.isFinite(tdb) || !Number.isFinite(tr)) return NaN;
  const va = Math.max(0.1, Math.min(20, Number.isFinite(v) ? v : 0.5));
  const rhClamped = Math.max(0, Math.min(100, Number.isFinite(rh) ? rh : 50));
  const Ta = tdb;
  const Tmrt = tr;
  const vpa = saturationVapourPressure(Ta) * (rhClamped / 100);

  const age = 35;
  const ht = 1.8;
  const mbody = 75.0;
  const p = 1013.25;
  const cb = 3640.0;
  const cair = 1010.0;
  const emsk = 0.99;
  const emcl = 0.95;
  const Lvap = 2.42e6;
  const sigm = 5.67e-8;
  const eta = 0.0;
  const tc_set = 36.6;
  const tsk_set = 34.0;
  const tbody_set = 0.1 * tsk_set + 0.9 * tc_set;

  const Adu = 0.203 * Math.pow(mbody, 0.425) * Math.pow(ht, 0.725);
  const feff = 0.725;
  const fcl = 1.0 + 0.31 * clo;
  const facl = Math.max(0, Math.min(1, (173.51 * clo - 2.36 - 100.76 * clo * clo + 19.28 * Math.pow(clo, 3)) / 100));
  const Aclo = Adu * facl + Adu * (fcl - 1.0);
  const Aeffr = Adu * feff;

  const hc = 2.67 + 6.5 * Math.pow(va, 0.67);
  const metab_male = 3.45 * Math.pow(mbody, 0.75) * (1.0 + 0.004 * (30.0 - age) + 0.01 * (ht * 100.0 / Math.pow(mbody, 1.0 / 3.0) - 43.4));
  const he = (met + metab_male) / Adu;
  const h = he * (1.0 - eta);

  const texp = 0.47 * Ta + 21.0;
  const dventpulm = he * 1.44e-6;
  const eres = cair * (Ta - texp) * dventpulm;
  const vpexp = 6.11 * Math.pow(10.0, 7.45 * texp / (235.0 + texp));
  const erel = 0.623 * (Lvap / p) * (vpa - vpexp) * dventpulm;
  const ere = eres + erel;

  const rcl = clo > 0.01 ? clo / 6.45 : 0.001;
  const y = (ht - 0.2) / ht;
  const r2 = Adu * (fcl - 1.0 + facl) / (6.28 * ht * y);
  const r1 = facl * Adu / (6.28 * ht * y);
  const di = r2 - r1;
  const htcl = clo > 0.01 ? (6.28 * ht * y * di) / (rcl * Math.log(r2 / r1) * Aclo) : 1e5;

  const Lw = 1.67;
  const he_diff = hc * Lw;
  const fecl = 1.0 / (1.0 + 0.92 * hc * rcl);
  const R_ecl = (1.0 / (fcl * hc) + rcl) / (Lw * 0.38);

  function syst3(T) {
    const Tcr = T[0], Tsk = T[1], Tcl = T[2];
    const sig_skin = Math.max(0, tsk_set - Tsk);
    const sig_core = Math.max(0, Tcr - tc_set);
    const qmblood = Math.min(90.0, (6.3 + 75.0 * sig_core) / (1.0 + 0.5 * sig_skin));
    const alpha = 0.1;

    const tbody = alpha * Tsk + (1.0 - alpha) * Tcr;
    const sig_body = Math.max(0, tbody - tbody_set);
    const qmsw = Math.min(500.0, 304.94e-3 * sig_body * 1000.0);
    const esw = (Lvap / 1000.0) * (qmsw / 3600.0);

    const Pvsk = 6.105 * Math.exp((17.27 * (Tsk + 273.15) - 4717.03) / (237.7 + Tsk));
    const emax = he_diff * fecl * (Pvsk - vpa);
    const w = emax > 0 ? Math.min(1.0, Math.max(0, esw / emax)) : 1.0;
    const ediff = (1.0 - w) * (Pvsk - vpa) / R_ecl;
    const evap = -(ediff + esw);

    const rbare = Aeffr * (1.0 - facl) * emsk * sigm * (Math.pow(Tmrt + 273.15, 4) - Math.pow(Tsk + 273.15, 4)) / Adu;
    const rclo = feff * Aclo * emcl * sigm * (Math.pow(Tmrt + 273.15, 4) - Math.pow(Tcl + 273.15, 4)) / Adu;
    const cbare = hc * (Ta - Tsk) * (1.0 - facl);
    const cclo = hc * (Ta - Tcl) * Aclo / Adu;

    const Kcs = (qmblood / 3600.0) * cb + 5.28;

    return [
      h + ere - Kcs * (Tcr - Tsk),
      rbare + cbare + evap + Kcs * (Tcr - Tsk) - htcl * (Tsk - Tcl),
      cclo + rclo + htcl * (Tsk - Tcl)
    ];
  }

  // 3-variable Newton-Raphson system solver
  const T = [37.0, 34.0, (Ta + Tmrt) / 2.0];
  for (let it = 0; it < 40; it++) {
    const f = syst3(T);
    if (Math.max(Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2])) < 1e-4) break;
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const eps = 1e-5;
    for (let j = 0; j < 3; j++) {
      const T_plus = [T[0], T[1], T[2]];
      T_plus[j] += eps;
      const f_plus = syst3(T_plus);
      for (let i = 0; i < 3; i++) J[i][j] = (f_plus[i] - f[i]) / eps;
    }
    const det = (J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1])
               - J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0])
               + J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]));
    if (Math.abs(det) < 1e-12) break;
    const d0 = (-f[0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) + f[1] * (J[0][1] * J[2][2] - J[0][2] * J[2][1]) - f[2] * (J[0][1] * J[1][2] - J[0][2] * J[1][1])) / det;
    const d1 = (f[0] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) - f[1] * (J[0][0] * J[2][2] - J[0][2] * J[2][0]) + f[2] * (J[0][0] * J[1][2] - J[0][2] * J[1][0])) / det;
    const d2 = (-f[0] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]) + f[1] * (J[0][0] * J[2][1] - J[0][1] * J[2][0]) - f[2] * (J[0][0] * J[1][1] - J[0][1] * J[1][0])) / det;
    const damping = Math.min(1.0, 5.0 / (Math.abs(d0) + Math.abs(d1) + Math.abs(d2) + 1e-6));
    T[0] += damping * d0;
    T[1] += damping * d1;
    T[2] += damping * d2;
  }

  // Indoor reference state: v = 0.1 m/s, rh = 50% (vpa = 12 hPa), clo = 0.9, met = 80 W
  const Tcr = T[0], Tsk = T[1], Tcl = T[2];
  const ref_icl = 0.9;
  const ref_fcl = 1.0 + 0.31 * ref_icl;
  const ref_facl = Math.max(0, Math.min(1, (173.51 * ref_icl - 2.36 - 100.76 * ref_icl * ref_icl + 19.28 * Math.pow(ref_icl, 3)) / 100));
  const ref_Aclo = Adu * ref_facl + Adu * (ref_fcl - 1.0);
  const ref_rcl = ref_icl / 6.45;
  const ref_r2 = Adu * (ref_fcl - 1.0 + ref_facl) / (6.28 * ht * y);
  const ref_r1 = ref_facl * Adu / (6.28 * ht * y);
  const ref_htcl = (6.28 * ht * y * (ref_r2 - ref_r1)) / (ref_rcl * Math.log(ref_r2 / ref_r1) * ref_Aclo);
  const ref_hc = 2.67 + 6.5 * Math.pow(0.1, 0.67);
  const ref_he_diff = ref_hc * Lw;
  const ref_fecl = 1.0 / (1.0 + 0.92 * ref_hc * ref_rcl);
  const ref_R_ecl = (1.0 / (ref_fcl * ref_hc) + ref_rcl) / (Lw * 0.38);
  const ref_vpa = 12.0;

  const tbody = 0.1 * Tsk + 0.9 * Tcr;
  const sig_body = Math.max(0, tbody - tbody_set);
  const qmsw = Math.min(500.0, 304.94e-3 * sig_body * 1000.0);
  const esw = (Lvap / 1000.0) * (qmsw / 3600.0);
  const Pvsk = 6.105 * Math.exp((17.27 * (Tsk + 273.15) - 4717.03) / (237.7 + Tsk));
  const emax = ref_he_diff * ref_fecl * (Pvsk - ref_vpa);
  const w = emax > 0 ? Math.min(1.0, Math.max(0, esw / emax)) : 1.0;
  const ediff = (1.0 - w) * (Pvsk - ref_vpa) / ref_R_ecl;
  const evap = -(ediff + esw);

  function evalRef(Tx) {
    const texp_ref = 0.47 * Tx + 21.0;
    const eres_ref = cair * (Tx - texp_ref) * dventpulm;
    const vpexp_ref = 6.11 * Math.pow(10.0, 7.45 * texp_ref / (235.0 + texp_ref));
    const erel_ref = 0.623 * (Lvap / p) * (ref_vpa - vpexp_ref) * dventpulm;
    const ere_ref = eres_ref + erel_ref;

    const rbare_ref = Aeffr * (1.0 - ref_facl) * emsk * sigm * (Math.pow(Tx + 273.15, 4) - Math.pow(Tsk + 273.15, 4)) / Adu;
    const rclo_ref = feff * ref_Aclo * emcl * sigm * (Math.pow(Tx + 273.15, 4) - Math.pow(Tcl + 273.15, 4)) / Adu;
    const cbare_ref = ref_hc * (Tx - Tsk) * (1.0 - ref_facl);
    const cclo_ref = ref_hc * (Tx - Tcl) * ref_Aclo / Adu;

    return h + ere_ref + rbare_ref + rclo_ref + cbare_ref + cclo_ref + evap;
  }

  let lo = -50.0, hi = 70.0;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2.0;
    if (evalRef(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2.0;
}
