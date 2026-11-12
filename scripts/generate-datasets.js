/**
 * generate-datasets.js
 * Generates:
 * 1. datasets/test_fault_24h.json (24 hourly/step frames with 14.85A surge fault)
 * 2. datasets/training_baseline_3months.json (90 days of normal telemetry)
 *
 * All frames adhere to the exact 11-field PZEM-004T + ESP32 mbedTLS signature format.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_DIR = path.join(__dirname, '..', 'datasets');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const ORG_ID = 'bput_college';
const DEVICE_ID = 'ESP32_HA_F4';
const SENSOR_ID = 'PZEM_004T_HA_F4';
// Use seed secret or known key
const SECRET_KEY = 'sk_2d4d579b1899a7a67104b2b638971fcd';

function formatIST(date) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(date.getTime() + (5.5 * 3600 * 1000));
  const yr = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const hr = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const sc = pad(d.getUTCSeconds());
  return `${yr}-${mo}-${da}T${hr}:${mi}:${sc}+05:30`;
}

function computeSig(secret, devId, ts, v, i, p, e) {
  const payload = `${devId}|${ts}|${v.toFixed(1)}|${i.toFixed(3)}|${p.toFixed(1)}|${e.toFixed(3)}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── 1. Generate test_fault_24h.json ──────────────────────────────────────────
console.log('Generating datasets/test_fault_24h.json (24 frames)...');
const testFrames = [];
const baseDate = new Date('2026-11-12T00:00:00Z');
let cumulativeEnergy = 12.000;

for (let hour = 0; hour < 24; hour++) {
  const date = new Date(baseDate.getTime() + hour * 3600 * 1000);
  const timestamp = formatIST(date);

  let voltage, current, power_factor, frequency;

  if (hour >= 12 && hour <= 18) {
    // ── High Usage Fault Window (Heavy Load Surge: 14.850A, 3354.2W) ──
    voltage = 230.5;
    current = 14.850;
    power_factor = 0.98;
    frequency = 50.0;
  } else {
    // ── Nominal Baseline Load (~2.35A, ~530W) ──
    voltage = 230.5;
    current = 2.350;
    power_factor = 0.98;
    frequency = 50.0;
  }

  const power = parseFloat((voltage * current * power_factor).toFixed(1));
  cumulativeEnergy += (power / 1000) * 1.0; // 1 hour step
  const energy = parseFloat(cumulativeEnergy.toFixed(3));

  const signature = computeSig(SECRET_KEY, DEVICE_ID, timestamp, voltage, current, power, energy);

  testFrames.push({
    org_id: ORG_ID,
    device_id: DEVICE_ID,
    sensor_id: SENSOR_ID,
    timestamp,
    voltage,
    current,
    power,
    energy,
    frequency,
    power_factor,
    signature,
  });
}

const testPath = path.join(OUT_DIR, 'test_fault_24h.json');
fs.writeFileSync(testPath, JSON.stringify(testFrames, null, 2), 'utf8');
console.log(`✓ Wrote ${testFrames.length} test frames to ${testPath}`);

// ── 2. Generate training_baseline_3months.json ────────────────────────────────
console.log('Generating datasets/training_baseline_3months.json (90 days baseline)...');
const trainFrames = [];
const trainStartDate = new Date('2026-08-14T00:00:00Z'); // 90 days before Nov 12
let trainEnergy = 100.000;

// PRNG for consistent realistic noise
let seed = 42;
function rng() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

const totalHours = 90 * 24; // 2,160 hourly readings
for (let h = 0; h < totalHours; h++) {
  const d = new Date(trainStartDate.getTime() + h * 3600 * 1000);
  const istDate = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const hourOfDay = istDate.getUTCHours();
  const dayOfWeek = istDate.getUTCDay(); // 0 = Sun, 6 = Sat
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  // Diurnal campus load factor:
  // Base night (11 PM - 6 AM): 0.3 - 0.4
  // Morning / Academic Day (8 AM - 5 PM): 0.8 - 1.0 (weekday) / 0.5 (weekend)
  // Evening (6 PM - 10 PM): 0.6 - 0.75
  let baseFactor = 0.35;
  if (hourOfDay >= 8 && hourOfDay <= 17) {
    baseFactor = isWeekend ? 0.50 : 0.90;
  } else if (hourOfDay >= 18 && hourOfDay <= 22) {
    baseFactor = 0.65;
  } else if (hourOfDay >= 6 && hourOfDay < 8) {
    baseFactor = 0.55;
  }

  // Realistic nominal voltage ~230V with slight load drop
  const voltage = parseFloat((231.0 - (baseFactor * 1.5) + (rng() - 0.5) * 1.0).toFixed(1));
  const power_factor = parseFloat((0.97 + (rng() - 0.5) * 0.02).toFixed(2));
  const frequency = parseFloat((50.0 + (rng() - 0.5) * 0.1).toFixed(1));

  // Current ranges: Nominal ~2.0A - 4.5A, never exceeding 5.5A in baseline
  const nominalBaseA = 2.4 * baseFactor * (1 + (rng() - 0.5) * 0.12);
  const current = parseFloat(nominalBaseA.toFixed(3));

  const power = parseFloat((voltage * current * power_factor).toFixed(1));
  trainEnergy += (power / 1000) * 1.0;
  const energy = parseFloat(trainEnergy.toFixed(3));

  const timestamp = formatIST(d);
  const signature = computeSig(SECRET_KEY, DEVICE_ID, timestamp, voltage, current, power, energy);

  trainFrames.push({
    org_id: ORG_ID,
    device_id: DEVICE_ID,
    sensor_id: SENSOR_ID,
    timestamp,
    voltage,
    current,
    power,
    energy,
    frequency,
    power_factor,
    signature,
  });
}

const trainPath = path.join(OUT_DIR, 'training_baseline_3months.json');
fs.writeFileSync(trainPath, JSON.stringify(trainFrames, null, 2), 'utf8');
console.log(`✓ Wrote ${trainFrames.length} training baseline frames to ${trainPath}`);
console.log('Done generating datasets!');
