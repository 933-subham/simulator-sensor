/**
 * noise.js
 * ─────────────────────────────────────────────────────────────
 * Seedable pseudo-random number generator (PRNG) using the
 * Mulberry32 algorithm — extremely fast, no dependencies.
 *
 * When RANDOM_SEED is set in .env, every run of the simulator
 * produces identical noise, making demos fully reproducible.
 * When no seed is given it falls back to Math.random().
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * Mulberry32 core — a fast 32-bit PRNG.
 * @param {number} seed - 32-bit integer seed
 * @returns {function} rand() that returns a float in [0, 1)
 */
function mulberry32(seed) {
  return function rand() {
    /* jshint bitwise: false */
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash an arbitrary string into a 32-bit integer.
 * Uses the djb2 algorithm — simple and good enough for seeding.
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Create a random-number generator.
 *
 * Usage:
 *   const { createRng } = require('./noise');
 *   const rand = createRng(process.env.RANDOM_SEED);
 *   const value = rand(); // float in [0, 1)
 *
 * @param {string|number|undefined} seed - Optional seed.
 *   Any string or number produces a deterministic sequence.
 *   Pass undefined/null/'' to use Math.random (non-repeatable).
 * @returns {function} rand() returning a float in [0, 1)
 */
function createRng(seed) {
  if (seed === undefined || seed === null || seed === '') {
    // Non-seeded: use platform Math.random
    return () => Math.random();
  }

  // Convert any seed type to a 32-bit integer
  const numericSeed =
    typeof seed === 'number'
      ? Math.trunc(seed)
      : hashString(String(seed));

  return mulberry32(numericSeed);
}

module.exports = { createRng };
