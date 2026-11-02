/**
 * patterns.js
 * ─────────────────────────────────────────────────────────────
 * Daily load profiles for the four campus building types.
 *
 * A "load factor" (0.0–1.0) scales the baseline power/flow
 * value for a device.  1.0 = device is at its rated capacity.
 *
 * Each profile is a list of [hour, loadFactor] anchor points.
 * Between anchors we linearly interpolate for smooth curves.
 *
 * Building types:
 *   hostel   – peaks morning (6–9 am) and evening (6–10 pm)
 *   academic – weekday 9 am–5 pm peak
 *   labs     – weekday 9 am–6 pm peak (heavier overnight baseline)
 *   library  – 10 am–8 pm peak, closes early on weekends
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ── Anchor-point profiles ────────────────────────────────────────────────────
// Format: [hour (0–23), loadFactor (0.0–1.0)]
// The last anchor wraps around to hour 24 (= midnight next day).

const PROFILES = {
  hostel: [
    [0,  0.15],  // midnight — most students asleep
    [5,  0.10],  // 5 am     — lowest point
    [6,  0.45],  // 6 am     — morning rush starts
    [7,  0.80],  // 7 am     — showers, kettles, charging
    [8,  0.85],  // 8 am     — peak morning
    [9,  0.55],  // 9 am     — most students left for class
    [10, 0.35],
    [13, 0.35],  // 1 pm     — lunchtime mini-peak
    [14, 0.30],
    [17, 0.40],  // 5 pm     — returning from class
    [18, 0.75],  // 6 pm     — evening rush
    [19, 0.90],  // 7 pm     — peak evening (dinner + study + screens)
    [20, 0.85],
    [21, 0.70],
    [22, 0.45],  // 10 pm    — winding down
    [23, 0.25],  // 11 pm
    [24, 0.15],  // wraps to midnight
  ],

  academic: [
    [0,  0.08],  // night — HVAC ticking over only
    [6,  0.08],
    [7,  0.20],  // 7 am — early arrivals, labs warming up
    [8,  0.40],
    [9,  0.85],  // 9 am — lectures begin
    [10, 0.92],
    [12, 0.70],  // noon — lunch break
    [13, 0.75],
    [14, 0.92],  // 2 pm — afternoon sessions
    [17, 0.75],
    [18, 0.40],  // 6 pm — evening classes
    [19, 0.20],
    [21, 0.10],
    [24, 0.08],
  ],

  labs: [
    [0,  0.12],  // labs have equipment running 24/7
    [7,  0.12],
    [8,  0.45],
    [9,  0.88],  // 9 am — lab sessions begin
    [11, 0.96],  // 11 am — peak usage
    [12, 0.72],
    [13, 0.76],
    [14, 0.96],  // 2 pm — afternoon peak
    [17, 0.82],
    [18, 0.55],  // 6 pm — winding down
    [19, 0.38],
    [20, 0.22],
    [22, 0.14],
    [24, 0.12],
  ],

  library: [
    [0,  0.05],  // closed
    [7,  0.05],
    [8,  0.15],  // 8 am — opens, small staff
    [9,  0.40],
    [10, 0.70],  // 10 am — students arrive
    [11, 0.80],
    [12, 0.62],  // noon — lunch break exodus
    [13, 0.68],
    [14, 0.82],  // 2 pm — afternoon study
    [17, 0.85],  // 5 pm — post-class rush
    [19, 0.72],
    [20, 0.48],  // 8 pm — closing soon
    [21, 0.12],  // 9 pm — nearly closed
    [22, 0.05],
    [24, 0.05],
  ],
};

/**
 * Linear interpolation between two values.
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor [0, 1]
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Get the load factor for a specific building type at a given time.
 *
 * Example:
 *   const factor = getLoadFactor('hostel', new Date());
 *   // factor ≈ 0.85 at 7:30 am on a weekday
 *
 * @param {string} buildingType - 'hostel' | 'academic' | 'labs' | 'library'
 * @param {Date}   date         - The moment you want the load factor for
 * @returns {number} Load factor in [0.0, 1.0]
 */
function getLoadFactor(buildingType, date) {
  const profile = PROFILES[buildingType] || PROFILES.academic;

  // Fractional hour, e.g. 7:30 am → 7.5
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;

  // Weekend dip: Saturday (6) and Sunday (0) run at 55% of weekday load
  const dayOfWeek = date.getDay();
  const weekendMultiplier = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.55 : 1.0;

  // Find the two surrounding anchor points
  let lo = profile[0];
  let hi = profile[profile.length - 1];

  for (let i = 0; i < profile.length - 1; i++) {
    if (hour >= profile[i][0] && hour < profile[i + 1][0]) {
      lo = profile[i];
      hi = profile[i + 1];
      break;
    }
  }

  // Interpolate between the two anchors
  const span = hi[0] - lo[0];
  const t    = span > 0 ? (hour - lo[0]) / span : 0;
  const base = lerp(lo[1], hi[1], t);

  return Math.min(1.0, Math.max(0.0, base * weekendMultiplier));
}

module.exports = { getLoadFactor, PROFILES };
