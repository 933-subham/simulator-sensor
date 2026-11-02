/**
 * engine.js
 * ─────────────────────────────────────────────────────────────
 * The simulation engine — the beating heart of the simulator.
 *
 * What it does on every tick (default every 2 seconds):
 *   1. For each registered device, generate a realistic reading
 *      based on the current time-of-day and building type.
 *   2. Apply any active fault modifiers.
 *   3. Handle special attack faults (spoof, replay, flood…).
 *   4. Store the reading in the rolling history buffer.
 *   5. Emit a 'tick' event so SSE clients get instant updates.
 *   6. If PUSH_ENABLED, POST each reading to PUSH_TARGET_URL.
 *
 * On startup:
 *   • Loads seed devices from config and generates their secrets.
 *   • Backfills 24 hours of history at 5-minute intervals so the
 *     dashboard has data immediately (no empty charts).
 *
 * Device registry is entirely in-memory — it resets on restart.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const crypto       = require('crypto');
const EventEmitter = require('events');
const { SEED_DEVICES } = require('../config/devices.config');
const { getLoadFactor } = require('./patterns');
const { createRng }    = require('./noise');
const faults           = require('./faults');

// ── Configuration ─────────────────────────────────────────────────────────────

const TICK_MS          = parseInt(process.env.TICK_INTERVAL_MS, 10) || 2000;
const RANDOM_FAULTS    = process.env.RANDOM_FAULTS === 'true';
const PUSH_ENABLED     = process.env.PUSH_ENABLED  === 'true';
const PUSH_TARGET_URL  = process.env.PUSH_TARGET_URL || '';

/** Max readings kept per device in the rolling buffer (≈48 h at 2 s tick). */
const MAX_HISTORY_PER_DEVICE = 2880;

/** Backfill window in milliseconds (24 hours). */
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Backfill step in milliseconds (one reading every 5 minutes). */
const BACKFILL_STEP_MS = 5 * 60 * 1000;

// ── Engine state ──────────────────────────────────────────────────────────────

/**
 * Device registry.
 * Map<deviceId, DeviceRecord>
 *
 * DeviceRecord shape:
 * {
 *   deviceId, kind, label, buildingType, baseline,
 *   tankCapacityLitres,   // water_tank only
 *   claimCode,            // one-time claim token (shown in control panel)
 *   secret,               // HMAC secret — never returned in API lists
 *   status,               // 'online' | 'offline' | 'fault'
 *   createdAt,
 *   claimed,              // true after POST /api/claim used the claimCode
 *   claimedAt,
 *   isSeed,               // true for devices loaded from config
 *   // simulation state
 *   seq,                  // incrementing sequence number (outbound)
 *   lastPushSeq,          // last accepted sequence from inbound push
 *   cumulatives: { energy_kwh, total_consumption_litres },
 *   tankLevel,            // 0–100 (water_tank only)
 *   refilling,            // is the tank currently being refilled?
 *   frozenValues,         // used by stuck_value / replay_attack
 * }
 */
const devices = new Map();

/**
 * History buffer.
 * Map<deviceId, reading[]>   — newest readings are at the end.
 */
const history = new Map();

/** Spoofed readings injected by the spoofed_sensor attack fault. */
const spoofedReadings = [];

/** Node EventEmitter — SSE route listens on 'tick'. */
const emitter = new EventEmitter();
emitter.setMaxListeners(500); // allow many simultaneous SSE clients

let _tickTimer  = null;
let _startedAt  = null;

// ── Helpers: crypto ───────────────────────────────────────────────────────────

/**
 * Generate a URL-safe random token.
 * @param {number} byteLen - Number of random bytes (hex output = 2× longer)
 * @returns {string}
 */
function _randomToken(byteLen) {
  return crypto.randomBytes(byteLen).toString('hex');
}

/**
 * Generate a claim code in the format CLAIM-XXXX-XXXX.
 * @returns {string}
 */
function _newClaimCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CLAIM-${part()}-${part()}`;
}

/**
 * Produce canonical JSON: object keys sorted alphabetically.
 * This ensures the HMAC signature is deterministic regardless of
 * the order properties were set on the object.
 * @param {Object} obj
 * @returns {string}
 */
function canonicalJson(obj) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
  );
}

/**
 * Compute an HMAC-SHA256 signature for outbound push.
 *
 * Payload string format (documented in README):
 *   deviceId + "." + timestamp + "." + seq + "." + canonicalJson(values)
 *
 * @param {string} secret     - Device's HMAC secret
 * @param {string} deviceId
 * @param {string} timestamp  - ISO 8601 string
 * @param {number} seq        - Sequence number
 * @param {Object} values     - Reading values object
 * @returns {string} Hex-encoded HMAC-SHA256
 */
function sign(secret, deviceId, timestamp, seq, values) {
  const payload = `${deviceId}.${timestamp}.${seq}.${canonicalJson(values)}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── Helpers: reading generation ───────────────────────────────────────────────

/** PRNG (seeded or random based on env). */
let _rand = createRng(process.env.RANDOM_SEED);

/**
 * Simulate a power_meter reading at a specific point in time.
 * @param {Object} device - DeviceRecord
 * @param {Date}   date
 * @returns {Object} Raw values (before fault application)
 */
function _powerReading(device, date) {
  const load = getLoadFactor(device.buildingType, date);
  const { baseline } = device;

  // Power with ±3% noise
  const power_kw      = Math.max(0.5,
    baseline.power_kw * load * (1 + (_rand() - 0.5) * 0.06));

  // Voltage dips slightly under heavy load
  const voltage       = baseline.voltage
    - load * 2                          // -2 V at full load
    + (_rand() - 0.5) * 2.5;           // ±1.25 V noise

  const power_factor  = Math.min(0.99,
    baseline.power_factor + (_rand() - 0.5) * 0.02);

  const current       = parseFloat(
    ((power_kw * 1000) / (voltage * power_factor)).toFixed(2));

  const frequency     = 50.0 + (_rand() - 0.5) * 0.08; // 49.96–50.04 Hz

  // Cumulative energy — increases by kWh consumed in this tick
  device.cumulatives.energy_kwh += power_kw * (TICK_MS / 3_600_000);

  return {
    power_kw:     parseFloat(power_kw.toFixed(2)),
    voltage:      parseFloat(voltage.toFixed(2)),
    current,
    power_factor: parseFloat(power_factor.toFixed(3)),
    frequency:    parseFloat(frequency.toFixed(3)),
    energy_kwh:   parseFloat(device.cumulatives.energy_kwh.toFixed(3)),
  };
}

/**
 * Simulate a water_tank reading at a specific point in time.
 * @param {Object} device - DeviceRecord
 * @param {Date}   date
 * @returns {Object} Raw values (before fault application)
 */
function _waterReading(device, date) {
  const load = getLoadFactor(device.buildingType, date);
  const { baseline, tankCapacityLitres } = device;

  // Flow with ±4% noise
  const flow_lpm      = Math.max(0,
    baseline.flow_lpm * load * (1 + (_rand() - 0.5) * 0.08));

  const pressure_bar  = Math.max(0.1,
    baseline.pressure_bar + (_rand() - 0.5) * 0.25);

  // Tank drains with consumption; refills when level drops below 20%
  const drainedLitres = flow_lpm * (TICK_MS / 60_000);
  device.cumulatives.total_consumption_litres += drainedLitres;

  const drainPct = (drainedLitres / tankCapacityLitres) * 100;
  device.tankLevel -= drainPct;

  if (device.tankLevel < 20) device.refilling = true;
  if (device.refilling) {
    device.tankLevel += drainPct * 2.2; // refill 2.2× faster than drain
  }
  if (device.tankLevel >= 95) device.refilling = false;
  device.tankLevel = Math.min(100, Math.max(0, device.tankLevel));

  return {
    flow_lpm:                 parseFloat(flow_lpm.toFixed(2)),
    pressure_bar:             parseFloat(pressure_bar.toFixed(3)),
    tank_level_percent:       parseFloat(device.tankLevel.toFixed(1)),
    total_consumption_litres: parseFloat(device.cumulatives.total_consumption_litres.toFixed(1)),
    leak_detected:            false,
  };
}

/**
 * Build one complete reading object for a device.
 * Applies faults, attack behaviours, and labels.
 *
 * @param {Object}  device      - DeviceRecord
 * @param {Date}    date        - Timestamp of the reading
 * @param {boolean} isBackfill  - True during startup backfill
 * @returns {Object[]} Usually one reading; duplicate_flood can return many
 */
function _buildReadings(device, date, isBackfill = false) {
  const { deviceId, kind } = device;

  // 1. Generate base values from daily pattern
  const baseValues = kind === 'power_meter'
    ? _powerReading(device, date)
    : _waterReading(device, date);

  // 2. Check for attack faults that need special handling
  const attackFaults = isBackfill ? [] : faults.getAttackFaults(deviceId);
  const hasStuck     = attackFaults.includes('stuck_value')   || attackFaults.includes('replay_attack');
  const hasFlood     = attackFaults.includes('duplicate_flood');
  const hasSkew      = attackFaults.includes('clock_skew');
  const hasHeartbeat = attackFaults.includes('missing_heartbeat');

  // missing_heartbeat: skip — return empty array
  if (hasHeartbeat) return [];

  // stuck_value / replay_attack: freeze at last known values
  let effectiveValues = baseValues;
  if (hasStuck && device.frozenValues) {
    effectiveValues = { ...device.frozenValues };
  } else {
    device.frozenValues = { ...baseValues };
  }

  // 3. Apply standard fault modifiers (spike, overload, leak, etc.)
  const { values, status, meta } = faults.apply(
    effectiveValues, kind, deviceId, _rand
  );

  // 4. Apply clock skew to timestamp
  let timestamp = date.toISOString();
  if (hasSkew) {
    const skewMs = 2 * 60 * 60 * 1000; // ±2 hours
    timestamp = new Date(date.getTime() - skewMs).toISOString();
    meta.isAnomaly = true;
    if (!meta.faultTypes.includes('clock_skew')) meta.faultTypes.push('clock_skew');
  }

  device.seq += 1;

  const reading = {
    deviceId,
    kind,
    label:     device.label,
    timestamp,
    seq:       device.seq,
    values,
    status:    device.status === 'offline' ? 'offline' : status,
    // _meta is always stored internally; exposed to client only when ?labels=true
    _meta: meta,
  };

  // 5. duplicate_flood: produce N copies with the same timestamp
  if (hasFlood) {
    const copies = [];
    for (let i = 0; i < 8; i++) {
      device.seq += 1;
      copies.push({ ...reading, seq: device.seq, _meta: { ...meta, faultTypes: ['duplicate_flood'], isAnomaly: true } });
    }
    return copies;
  }

  return [reading];
}

// ── Device management ─────────────────────────────────────────────────────────

/**
 * Register a device into the in-memory registry.
 * @param {Object} def         - Device definition (from config or POST /api/devices)
 * @param {Object} [overrides] - Pre-generated secret / claimCode (for seed devices)
 * @returns {Object} The full DeviceRecord (contains secret!)
 */
function registerDevice(def, overrides = {}) {
  const deviceId  = def.deviceId;
  const secret    = overrides.secret    || ('sk_' + _randomToken(24));
  const claimCode = overrides.claimCode || _newClaimCode();

  const record = {
    deviceId,
    kind:            def.kind,
    label:           def.label || deviceId,
    buildingType:    def.buildingType || 'academic',
    baseline:        def.baseline     || (def.kind === 'power_meter'
      ? { power_kw: 40, voltage: 230, power_factor: 0.92 }
      : { flow_lpm: 20, pressure_bar: 3.0 }),
    tankCapacityLitres: def.tankCapacityLitres || 5000,
    claimCode,
    secret,
    status:          'online',
    createdAt:       new Date().toISOString(),
    claimed:         false,
    claimedAt:       null,
    isSeed:          !!def.isSeed,
    // simulation state
    seq:             0,
    lastPushSeq:     -1,
    cumulatives: {
      energy_kwh:               _rand() * 500,  // random starting offset
      total_consumption_litres: _rand() * 10000,
    },
    tankLevel:    50 + _rand() * 30,  // start between 50–80%
    refilling:    false,
    frozenValues: null,
  };

  devices.set(deviceId, record);
  history.set(deviceId, []);
  return record;
}

/**
 * Remove a device from the registry.
 * @param {string} deviceId
 * @returns {boolean} True if device existed and was removed
 */
function removeDevice(deviceId) {
  if (!devices.has(deviceId)) return false;
  devices.delete(deviceId);
  history.delete(deviceId);
  return true;
}

// ── History buffer ─────────────────────────────────────────────────────────────

/**
 * Add readings to the history buffer, enforcing the max size.
 * @param {string}   deviceId
 * @param {Object[]} readings
 */
function _addToHistory(deviceId, readings) {
  const buf = history.get(deviceId);
  if (!buf) return;
  buf.push(...readings);
  if (buf.length > MAX_HISTORY_PER_DEVICE) {
    buf.splice(0, buf.length - MAX_HISTORY_PER_DEVICE);
  }
}

// ── Startup backfill ──────────────────────────────────────────────────────────

/**
 * Generate 24 hours of historical readings (one per 5 minutes per device).
 * This gives the dashboard data to render immediately on startup.
 */
function _backfill() {
  console.log('[engine] Backfilling 24 h of history…');
  const now   = Date.now();
  const start = now - BACKFILL_WINDOW_MS;

  for (let t = start; t < now; t += BACKFILL_STEP_MS) {
    const date = new Date(t);
    for (const [, device] of devices) {
      const readings = _buildReadings(device, date, /* isBackfill */ true);
      _addToHistory(device.deviceId, readings);
    }
  }

  console.log(`[engine] Backfill complete — ${BACKFILL_STEP_MS / 60000} min intervals × ${devices.size} devices.`);
}

// ── Outbound push ─────────────────────────────────────────────────────────────

/**
 * POST one reading to the external PUSH_TARGET_URL.
 * Signed with the device's secret, 5-second timeout, one retry, never throws.
 *
 * @param {Object} device  - DeviceRecord
 * @param {Object} reading - Full reading object
 */
async function _pushReading(device, reading) {
  if (!PUSH_ENABLED || !PUSH_TARGET_URL) return;

  const { deviceId, secret } = device;
  const { timestamp, seq, values } = reading;
  const signature = sign(secret, deviceId, timestamp, seq, values);

  const body = JSON.stringify(reading);
  const headers = {
    'Content-Type': 'application/json',
    'x-device-id':  deviceId,
    'x-timestamp':  timestamp,
    'x-seq':        String(seq),
    'x-signature':  signature,
  };

  const attempt = async () => {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(PUSH_TARGET_URL, {
        method: 'POST', headers, body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      clearTimeout(timeout);
      return false;
    }
  };

  const ok = await attempt();
  if (!ok) {
    // One retry after 1 s
    await new Promise(r => setTimeout(r, 1000));
    await attempt();
    // Silently ignore second failure — never crash
  }
}

// ── Webhook notifications ─────────────────────────────────────────────────────

/**
 * Fire the fault webhook if FAULT_WEBHOOK_URL is configured.
 * @param {'fault_started'|'fault_cleared'} event
 * @param {Object} fault - Fault record
 */
async function fireFaultWebhook(event, fault) {
  const url    = process.env.FAULT_WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!url) return;

  const payload = JSON.stringify({ event, fault, timestamp: new Date().toISOString() });
  const headers  = {
    'Content-Type':     'application/json',
    'x-webhook-secret': secret || '',
  };

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
  } catch {
    // Never crash on webhook failure
  } finally {
    clearTimeout(timeout);
  }
}

// ── Spoofed sensor injection ──────────────────────────────────────────────────

/**
 * Inject a spoofed reading from a fake device ID.
 * Called each tick for devices that have a 'spoofed_sensor' fault active.
 * @param {Object} realDevice - The device being spoofed
 * @param {Date}   date
 */
function _injectSpoofedReading(realDevice, date) {
  // Use a deterministic-looking but unregistered device ID
  const fakeId  = `dev-SPOOF-${realDevice.deviceId.slice(-4)}`;
  const lastReal = history.get(realDevice.deviceId);
  const baseVals = lastReal && lastReal.length > 0
    ? { ...lastReal[lastReal.length - 1].values }
    : {};

  spoofedReadings.push({
    deviceId:  fakeId,
    kind:      realDevice.kind,
    label:     `[SPOOFED] ${realDevice.label}`,
    timestamp: date.toISOString(),
    seq:       Math.floor(Math.random() * 9999),
    values:    baseVals,
    status:    'online',
    _meta: {
      isAnomaly:  true,
      faultIds:   [],
      faultTypes: ['spoofed_sensor'],
    },
  });

  // Keep spoofed buffer small
  if (spoofedReadings.length > 200) spoofedReadings.shift();
}

// ── Main tick ─────────────────────────────────────────────────────────────────

/**
 * Run one simulation tick.
 *   1. Advance fault timers.
 *   2. Generate readings for every device.
 *   3. Store in history.
 *   4. Emit 'tick' event for SSE.
 *   5. Push to target URL if enabled.
 */
async function _tick() {
  const now = new Date();
  faults.tick(TICK_MS);

  const batchReadings = [];

  for (const [, device] of devices) {
    // Check for spoofed_sensor attack fault
    const attackTypes = faults.getAttackFaults(device.deviceId);
    if (attackTypes.includes('spoofed_sensor')) {
      _injectSpoofedReading(device, now);
    }

    const readings = _buildReadings(device, now);
    if (readings.length === 0) continue; // missing_heartbeat — skip

    _addToHistory(device.deviceId, readings);
    batchReadings.push(...readings);

    // Outbound push (fire-and-forget)
    for (const r of readings) {
      _pushReading(device, r).catch(() => {});
    }
  }

  // Emit for SSE subscribers
  emitter.emit('tick', batchReadings, spoofedReadings.slice(-50));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the engine: register seed devices, backfill, begin tick loop. */
function start() {
  if (_tickTimer) return; // already running
  _startedAt = new Date();

  // Register seed devices
  for (const def of SEED_DEVICES) {
    registerDevice({ ...def, isSeed: true });
  }

  // Backfill history
  _backfill();

  // Start tick loop
  _tickTimer = setInterval(() => { _tick().catch(console.error); }, TICK_MS);
  console.log(`[engine] Started — tick every ${TICK_MS} ms, ${devices.size} devices.`);
}

/** Stop the engine (for graceful shutdown / tests). */
function stop() {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

/** Reset simulation: clear history, faults, and re-seed. */
function reset() {
  stop();
  devices.clear();
  history.clear();
  spoofedReadings.length = 0;
  faults.clearAll();
  _rand = createRng(process.env.RANDOM_SEED); // reset PRNG too
  start();
}

/** Get all devices (never exposes secrets). */
function listDevices() {
  return [...devices.values()].map(d => ({
    deviceId:    d.deviceId,
    kind:        d.kind,
    label:       d.label,
    buildingType: d.buildingType,
    claimCode:   d.claimed ? null : d.claimCode,
    status:      d.status,
    createdAt:   d.createdAt,
    claimed:     d.claimed,
    claimedAt:   d.claimedAt,
    isSeed:      d.isSeed,
  }));
}

/** Get a single device (for routes that need the secret, e.g. claim). */
function getDeviceRaw(deviceId) {
  return devices.get(deviceId) || null;
}

/**
 * Get latest reading for one or all devices.
 * @param {Object} [filter] - { kind?, labelPrefix? }
 * @returns {Object[]} Latest readings (without _meta unless requested)
 */
function getLatest(filter = {}) {
  const results = [];
  for (const [deviceId, buf] of history) {
    if (buf.length === 0) continue;
    const device = devices.get(deviceId);
    if (!device) continue;

    if (filter.kind && device.kind !== filter.kind) continue;
    if (filter.labelPrefix &&
        !device.label.toLowerCase().startsWith(filter.labelPrefix.toLowerCase())) continue;

    results.push(buf[buf.length - 1]);
  }
  // Include spoofed readings in the latest batch
  if (!filter.kind || filter.kind === 'all') {
    const recentSpoofed = spoofedReadings.slice(-devices.size);
    results.push(...recentSpoofed);
  }
  return results;
}

/**
 * Get historical readings for a specific device.
 * @param {string} deviceId
 * @param {Object} opts - { minutes?, from?, to? }
 * @returns {Object[]}
 */
function getHistory(deviceId, opts = {}) {
  const buf = history.get(deviceId);
  if (!buf) return null; // device not found

  const now = Date.now();

  let from, to;
  if (opts.from) from = new Date(opts.from).getTime();
  if (opts.to)   to   = new Date(opts.to).getTime();
  if (opts.minutes) from = now - opts.minutes * 60_000;
  if (!from) from = now - 60 * 60_000; // default: last hour
  if (!to)   to   = now;

  return buf.filter(r => {
    const t = new Date(r.timestamp).getTime();
    return t >= from && t <= to;
  });
}

/**
 * Build a summary of current state across all devices.
 * @returns {Object}
 */
function getSummary() {
  let totalPowerKw = 0;
  let totalLitresToday = 0;
  const byKind = { power_meter: [], water_tank: [] };
  const activeFaultsList = faults.getActive();

  for (const [, device] of devices) {
    const buf = history.get(device.deviceId);
    const latest = buf && buf.length > 0 ? buf[buf.length - 1] : null;
    if (!latest) continue;

    if (device.kind === 'power_meter') {
      totalPowerKw += latest.values.power_kw || 0;
      byKind.power_meter.push({
        deviceId: device.deviceId,
        label:    device.label,
        power_kw: latest.values.power_kw,
        status:   latest.status,
      });
    } else {
      // total_consumption_litres is cumulative; estimate today's usage
      // from the difference between current value and value 24 h ago
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const buf24 = history.get(device.deviceId) || [];
      const firstToday = buf24.find(r => new Date(r.timestamp) >= todayStart);
      const startLitres = firstToday
        ? firstToday.values.total_consumption_litres
        : latest.values.total_consumption_litres;
      const todayLitres = Math.max(0,
        (latest.values.total_consumption_litres || 0) - (startLitres || 0));
      totalLitresToday += todayLitres;

      byKind.water_tank.push({
        deviceId:          device.deviceId,
        label:             device.label,
        tank_level_percent: latest.values.tank_level_percent,
        flow_lpm:          latest.values.flow_lpm,
        leak_detected:     latest.values.leak_detected,
        status:            latest.status,
      });
    }
  }

  return {
    timestamp:       new Date().toISOString(),
    totalPowerKw:    parseFloat(totalPowerKw.toFixed(2)),
    totalLitresToday: parseFloat(totalLitresToday.toFixed(1)),
    activeFaults:    activeFaultsList.length,
    devices: {
      total:   devices.size,
      online:  [...devices.values()].filter(d => d.status === 'online').length,
      offline: [...devices.values()].filter(d => d.status === 'offline').length,
      fault:   [...devices.values()].filter(d => d.status === 'fault').length,
    },
    byKind,
  };
}

/**
 * Claim a device by its claim code.
 * Returns the secret exactly once; marks the code as used.
 * @param {string} claimCode
 * @returns {{ deviceId, kind, label, secret }|null}
 */
function claimDevice(claimCode) {
  for (const [, device] of devices) {
    if (device.claimCode === claimCode && !device.claimed) {
      device.claimed   = true;
      device.claimedAt = new Date().toISOString();
      return {
        deviceId: device.deviceId,
        kind:     device.kind,
        label:    device.label,
        secret:   device.secret,
      };
    }
  }
  return null; // not found or already claimed
}

/**
 * Validate an inbound push reading from an external device.
 *
 * Security checks (all required):
 *   1. deviceId must exist in the registry.
 *   2. Timestamp must be within 60 seconds of server time.
 *   3. seq must be strictly greater than the last seen seq.
 *   4. HMAC signature must match (constant-time comparison).
 *
 * @param {string} deviceId
 * @param {string} timestamp  - ISO string from x-timestamp header
 * @param {number} seq        - From x-seq header
 * @param {string} signature  - From x-signature header
 * @param {Object} values     - Parsed reading values
 * @returns {{ ok: boolean, error?: string, status?: number }}
 */
function validatePush(deviceId, timestamp, seq, signature, values) {
  const device = devices.get(deviceId);
  if (!device) {
    return { ok: false, error: 'Unknown device ID', status: 401 };
  }

  // Timestamp freshness check — reject stale or future timestamps
  const ts  = new Date(timestamp).getTime();
  const now = Date.now();
  if (isNaN(ts)) {
    return { ok: false, error: 'Invalid timestamp format', status: 400 };
  }
  if (Math.abs(now - ts) > 60_000) {
    return { ok: false, error: 'Timestamp out of acceptable window (±60 s)', status: 401 };
  }

  // Sequence number replay prevention
  const seqNum = parseInt(seq, 10);
  if (isNaN(seqNum) || seqNum <= device.lastPushSeq) {
    return { ok: false, error: 'Sequence number must be greater than last accepted', status: 409 };
  }

  // HMAC signature verification (constant-time)
  const expected = sign(device.secret, deviceId, timestamp, seqNum, values);
  const sigBuf   = Buffer.from(signature, 'hex');
  const expBuf   = Buffer.from(expected, 'hex');

  let valid = false;
  if (sigBuf.length === expBuf.length) {
    try { valid = crypto.timingSafeEqual(sigBuf, expBuf); } catch { valid = false; }
  }
  if (!valid) {
    return { ok: false, error: 'Invalid signature', status: 401 };
  }

  // All checks passed — accept push
  device.lastPushSeq = seqNum;
  return { ok: true };
}

/**
 * Store a validated pushed reading in the history buffer.
 * @param {string} deviceId
 * @param {Object} reading
 */
function storePushedReading(deviceId, reading) {
  _addToHistory(deviceId, [reading]);
}

/** Server uptime information. */
function getUptime() {
  return {
    startedAt: _startedAt ? _startedAt.toISOString() : null,
    uptimeSeconds: _startedAt ? Math.floor((Date.now() - _startedAt.getTime()) / 1000) : 0,
  };
}

module.exports = {
  start,
  stop,
  reset,
  tick: _tick,
  emitter,
  registerDevice,
  removeDevice,
  listDevices,
  getDeviceRaw,
  getLatest,
  getHistory,
  getSummary,
  claimDevice,
  validatePush,
  storePushedReading,
  getUptime,
  fireFaultWebhook,
  canonicalJson,
  sign,
  devices, // exported so routes can do lookups
};
