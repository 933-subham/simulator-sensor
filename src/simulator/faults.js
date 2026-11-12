/**
 * faults.js
 * ─────────────────────────────────────────────────────────────
 * Fault state machine for the sensor simulator.
 *
 * Responsibilities:
 *   • Registry of all active / recently cleared faults
 *   • inject()  — create a new fault, return its record
 *   • clear()   — mark a fault as recovering
 *   • clearAll() — clear every active fault
 *   • apply()   — given a base reading + all active faults for a
 *                 device, return modified values and meta labels
 *   • tick()    — advance ramp/recovery timers each simulation tick
 *   • getActive(), getLog() — for the REST routes
 *
 * Fault lifecycle:
 *   injected → ramping (if rampSec > 0) → active
 *             → (durationSec elapsed or DELETE) recovering → cleared
 *
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

// ── Fault catalogue ──────────────────────────────────────────────────────────

/**
 * Each entry defines:
 *   kinds     – which device kinds the fault targets (null = any)
 *   describe  – short description shown in the control panel
 *   apply     – function(values, kind, severity, rampPct) → modifiedValues
 *               rampPct goes 0→1 while ramping, stays 1 while active
 *
 * "Attack" fault types simulate cyber/physical attacks. They change
 * values in ways that look suspicious so your AI anomaly model can
 * detect them. Ground-truth labels are included when ?labels=true.
 */
const FAULT_CATALOGUE = {

  // ── Power meter faults ──────────────────────────────────────────────────

  spike: {
    kinds: ['power_meter'],
    describe: 'Short voltage spike — momentary surge',
    apply(v, kind, sev, ramp, rand, baseline) {
      const s = sev * ramp;
      const floorP = baseline?.power_kw ? Math.max(v.power_kw, baseline.power_kw * 0.85) : v.power_kw;
      const baseP = v.power_kw + (floorP - v.power_kw) * ramp;
      const newPower = baseP * (1 + 2.0 * s);
      const newV = v.voltage * (1 + 0.18 * s);
      return {
        ...v,
        power_kw:     newPower,
        voltage:      newV,
        current:      _current(newPower, newV, v.power_factor),
      };
    },
  },

  sag: {
    kinds: ['power_meter'],
    describe: 'Voltage sag — supply drops below nominal',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return {
        ...v,
        voltage:      v.voltage  * (1 - 0.22 * s),
        power_kw:     v.power_kw * (1 - 0.28 * s),
        current:      _current(v.power_kw * (1 - 0.28 * s), v.voltage * (1 - 0.22 * s), v.power_factor),
      };
    },
  },

  overload: {
    kinds: ['power_meter'],
    describe: 'Overload — current exceeds rated capacity',
    apply(v, kind, sev, ramp, rand, baseline) {
      const s = sev * ramp;
      const floorP = baseline?.power_kw ? Math.max(v.power_kw, baseline.power_kw * 0.90) : v.power_kw;
      const baseP = v.power_kw + (floorP - v.power_kw) * ramp;
      const newPower = baseP * (1 + 1.8 * s);
      const newV     = v.voltage  * (1 - 0.03 * s);   // slight voltage dip under load
      return {
        ...v,
        power_kw: newPower,
        voltage:  newV,
        current:  _current(newPower, newV, v.power_factor),
      };
    },
  },

  power_factor_drop: {
    kinds: ['power_meter'],
    describe: 'Poor power factor — reactive load increased',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      const newPF = Math.max(0.50, v.power_factor - 0.38 * s);
      return {
        ...v,
        power_factor: newPF,
        current: _current(v.power_kw, v.voltage, newPF),
      };
    },
  },

  frequency_drift: {
    kinds: ['power_meter'],
    describe: 'Grid frequency deviation',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return { ...v, frequency: v.frequency + 2.5 * s };
    },
  },

  blackout: {
    kinds: ['power_meter'],
    describe: 'Complete power outage',
    apply(v, kind, sev, ramp) {
      if (ramp < 0.5) return v; // instant once ramp crosses 50%
      return { ...v, power_kw: 0, voltage: 0, current: 0, power_factor: 0, frequency: 0 };
    },
  },

  // ── Water tank faults ───────────────────────────────────────────────────

  leak: {
    kinds: ['water_tank'],
    describe: 'Pipe leak — elevated flow, tank draining',
    apply(v, kind, sev, ramp, rand, baseline) {
      const s = sev * ramp;
      const floorFlow = baseline?.flow_lpm ? Math.max(v.flow_lpm, baseline.flow_lpm * 0.65) : Math.max(v.flow_lpm, 12);
      const baseF = v.flow_lpm + (floorFlow - v.flow_lpm) * ramp;
      return {
        ...v,
        flow_lpm:       baseF * (1 + 3.5 * s),
        leak_detected:  ramp > 0.3,
        pressure_bar:   v.pressure_bar * (1 - 0.15 * s),
      };
    },
  },

  burst: {
    kinds: ['water_tank'],
    describe: 'Pipe burst — catastrophic flow surge and pressure drop',
    apply(v, kind, sev, ramp, rand, baseline) {
      const s = sev * ramp;
      const floorFlow = baseline?.flow_lpm ? Math.max(v.flow_lpm, baseline.flow_lpm * 0.80) : Math.max(v.flow_lpm, 18);
      const baseF = v.flow_lpm + (floorFlow - v.flow_lpm) * ramp;
      return {
        ...v,
        flow_lpm:      baseF * (1 + 8 * s),
        pressure_bar:  v.pressure_bar * (1 - 0.55 * s),
        leak_detected: true,
      };
    },
  },

  low_pressure: {
    kinds: ['water_tank'],
    describe: 'Low supply pressure',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return {
        ...v,
        pressure_bar: v.pressure_bar * (1 - 0.65 * s),
        flow_lpm:     v.flow_lpm    * (1 - 0.35 * s),
      };
    },
  },

  tank_overflow: {
    kinds: ['water_tank'],
    describe: 'Tank overflow — level at 100%',
    apply(v) {
      return { ...v, tank_level_percent: 100, flow_lpm: 0 };
    },
  },

  tank_dry: {
    kinds: ['water_tank'],
    describe: 'Tank empty — no flow',
    apply(v) {
      return { ...v, tank_level_percent: 0, flow_lpm: 0, pressure_bar: 0 };
    },
  },

  // ── Waste Management faults ──────────────────────────────────────────────

  bin_overflow: {
    kinds: ['waste_bin', 'waste_compactor'],
    describe: 'Waste bin overflow — capacity exceeded (>100%), refuse spilling over',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return {
        ...v,
        fill_level_percent: 100,
        weight_kg: Math.round(v.weight_kg * (1 + 0.4 * s)),
        status: 'OVERFLOWING',
        odor_index_ppm: Math.round(v.odor_index_ppm * (1 + 1.2 * s)),
        spill_detected: true,
      };
    },
  },

  compactor_jam: {
    kinds: ['waste_compactor', 'waste_bin'],
    describe: 'Hydraulic compactor jam — mechanical stall or obstruction',
    apply(v) {
      return {
        ...v,
        compactor_active: false,
        compactor_status: 'JAMMED',
        status: 'COMPACTOR_JAMMED',
        motor_fault: true,
      };
    },
  },

  fire_hazard_heat: {
    kinds: ['waste_bin', 'waste_compactor'],
    describe: 'Waste smolder / thermal fire risk — temperature spike in receptacle',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return {
        ...v,
        temperature_c: parseFloat((30 + 55 * s).toFixed(1)),
        odor_index_ppm: Math.round(v.odor_index_ppm * (1 + 2.5 * s)),
        status: 'FIRE_HAZARD',
        thermal_anomaly: true,
      };
    },
  },

  methane_odor_spike: {
    kinds: ['waste_bin', 'waste_compactor'],
    describe: 'Bio-decomposition methane & volatile odor surge',
    apply(v, kind, sev, ramp) {
      const s = sev * ramp;
      return {
        ...v,
        odor_index_ppm: Math.round(40 + 120 * s),
        status: 'ODOR_SPIKE',
        voc_hazard: true,
      };
    },
  },

  // ── Common (any device) ─────────────────────────────────────────────────

  sensor_offline: {
    kinds: null,
    describe: 'Device goes offline — no readings',
    // Applied via status change in engine; values not needed here
    apply(v) { return v; },
  },

  stuck_value: {
    kinds: null,
    describe: 'Sensor stuck — same value repeated every tick',
    // Applied by freezing values in engine
    apply(v) { return v; },
  },

  noisy: {
    kinds: null,
    describe: 'Excessive noise on all channels',
    apply(v, kind, sev, ramp, rand) {
      const result = {};
      for (const [key, val] of Object.entries(v)) {
        if (typeof val === 'number') {
          result[key] = val * (1 + (rand() - 0.5) * 0.70 * sev * ramp);
        } else {
          result[key] = val;
        }
      }
      return result;
    },
  },

  drift: {
    kinds: null,
    describe: 'Slow systematic drift away from true value',
    apply(v, kind, sev, ramp) {
      const result = {};
      for (const [key, val] of Object.entries(v)) {
        if (typeof val === 'number') {
          result[key] = val * (1 + 0.40 * sev * ramp);
        } else {
          result[key] = val;
        }
      }
      return result;
    },
  },

  // ── Attack / cyber-physical fault types ────────────────────────────────
  // These simulate adversarial conditions that the AI anomaly model
  // and the main website's validation layer should detect.

  spoofed_sensor: {
    kinds: null,
    describe: 'Spoofed device — readings from an unregistered ID injected into the stream',
    // Engine handles spoofing by injecting a fake-ID reading; no value change to real device
    apply(v) { return v; },
  },

  replay_attack: {
    kinds: null,
    describe: 'Replay attack — old readings replayed with current timestamp',
    // Engine freezes values (like stuck_value) + marks meta
    apply(v) { return v; },
  },

  out_of_range: {
    kinds: null,
    describe: 'Out-of-range values — physically impossible readings',
    apply(v, kind) {
      if (kind === 'power_meter') {
        return { ...v, power_kw: 9999, voltage: 620, current: 8500, frequency: 99 };
      }
      if (kind === 'waste_bin' || kind === 'waste_compactor') {
        return { ...v, fill_level_percent: 250, weight_kg: 99999, temperature_c: 450, odor_index_ppm: 9999 };
      }
      return { ...v, flow_lpm: 99999, pressure_bar: 50, tank_level_percent: 200 };
    },
  },

  value_injection: {
    kinds: null,
    describe: 'Value injection — plausible but systematically falsified readings',
    apply(v, kind, sev, ramp) {
      // Values are shifted in a suspicious but plausible direction
      const result = {};
      for (const [key, val] of Object.entries(v)) {
        if (typeof val === 'number') {
          // Consistent downward bias — sensors reporting lower-than-real usage
          result[key] = val * (1 - 0.20 * sev * ramp);
        } else {
          result[key] = val;
        }
      }
      return result;
    },
  },

  duplicate_flood: {
    kinds: null,
    describe: 'Duplicate flood — device ID sends many identical readings per tick',
    // Engine generates extra copies each tick; no value change needed
    apply(v) { return v; },
  },

  clock_skew: {
    kinds: null,
    describe: 'Clock skew — timestamps are hours off from real time',
    // Engine shifts the timestamp; values are fine
    apply(v) { return v; },
  },

  missing_heartbeat: {
    kinds: null,
    describe: 'Missing heartbeat — device stops sending readings',
    // Engine skips the device for N ticks
    apply(v) { return v; },
  },
};

// ── Fault registry ───────────────────────────────────────────────────────────

/** Active + recently cleared faults. In-memory; resets on server restart. */
const _registry = new Map(); // faultId → faultRecord

/** Full log — never trimmed; used for AI model ground-truth comparison. */
const _log = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Calculate current from power, voltage and power factor. */
function _current(power_kw, voltage, pf) {
  if (!voltage || !pf) return 0;
  return parseFloat(((power_kw * 1000) / (voltage * pf)).toFixed(2));
}

/** Generate a short random fault ID. */
function _newId() {
  return 'flt-' + crypto.randomBytes(4).toString('hex');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Inject a new fault.
 *
 * @param {Object}   opts
 * @param {string[]} opts.deviceIds   - Resolved list of target device IDs
 * @param {string}   opts.type        - Fault type key from FAULT_CATALOGUE
 * @param {number}   [opts.severity]  - 0.1–1.0 (default 0.7)
 * @param {number}   [opts.durationSec] - Auto-clear after N seconds (omit = manual)
 * @param {number}   [opts.rampSec]   - Gradual onset over N seconds (omit = instant)
 * @returns {Object} The new fault record
 * @throws  {Error}  If type is unknown or deviceIds is empty
 */
function inject(opts) {
  const { deviceIds, type, severity = 0.7, durationSec, rampSec } = opts;

  if (!FAULT_CATALOGUE[type]) {
    throw Object.assign(new Error(`Unknown fault type: "${type}"`), { status: 400 });
  }
  if (!deviceIds || deviceIds.length === 0) {
    throw Object.assign(new Error('No target device IDs resolved'), { status: 400 });
  }

  const now = Date.now();
  const id  = _newId();

  const record = {
    id,
    deviceIds:   [...deviceIds],
    type,
    severity:    Math.min(1.0, Math.max(0.1, severity)),
    status:      rampSec > 0 ? 'ramping' : 'active',
    startedAt:   new Date(now).toISOString(),
    endsAt:      durationSec ? new Date(now + durationSec * 1000).toISOString() : null,
    clearedAt:   null,
    // Timing state (milliseconds)
    _rampMs:     (rampSec || 0) * 1000,
    _rampElapsed: 0,
    _durationMs: durationSec ? durationSec * 1000 : null,
    _activeMs:   0,
    _recoverMs:  0,
    _recoverTotal: 5000,  // recovery takes 5 s by default
  };

  _registry.set(id, record);
  _log.push({ ...record, _redacted: true }); // snapshot for log

  return record;
}

/**
 * Mark a fault as recovering (begins smooth value recovery).
 * @param {string} id - Fault ID
 * @returns {Object|null} Updated record, or null if not found
 */
function clear(id) {
  const rec = _registry.get(id);
  if (!rec) return null;

  rec.status    = 'recovering';
  rec.clearedAt = new Date().toISOString();
  _updateLog(rec);
  return rec;
}

/** Clear every active / ramping fault. */
function clearAll() {
  const cleared = [];
  for (const [id, rec] of _registry) {
    if (rec.status === 'active' || rec.status === 'ramping') {
      rec.status    = 'recovering';
      rec.clearedAt = new Date().toISOString();
      _updateLog(rec);
      cleared.push(rec);
    }
  }
  return cleared;
}

/**
 * Advance all fault timers by `deltaMsec`.
 * Call this once per engine tick.
 * @param {number} deltaMsec - Milliseconds elapsed since last tick
 */
function tick(deltaMsec) {
  for (const [id, rec] of _registry) {
    if (rec.status === 'ramping') {
      rec._rampElapsed += deltaMsec;
      if (rec._rampElapsed >= rec._rampMs) {
        rec.status = 'active';
      }
    } else if (rec.status === 'active') {
      rec._activeMs += deltaMsec;
      if (rec._durationMs !== null && rec._activeMs >= rec._durationMs) {
        rec.status    = 'recovering';
        rec.clearedAt = new Date().toISOString();
        _updateLog(rec);
      }
    } else if (rec.status === 'recovering') {
      rec._recoverMs += deltaMsec;
      if (rec._recoverMs >= rec._recoverTotal) {
        rec.status = 'cleared';
        _updateLog(rec);
        _registry.delete(id);
      }
    }
  }
}

/**
 * Apply all active faults for a device to its base reading values.
 *
 * @param {Object} baseValues  - Raw simulated values for the device
 * @param {string} kind        - 'power_meter' | 'water_tank'
 * @param {string} deviceId    - Device being rendered
 * @param {function} rand      - PRNG function
 * @returns {{ values: Object, status: string, meta: Object }}
 */
function apply(baseValues, kind, deviceId, rand, baseline = null) {
  let values = { ...baseValues };
  let status = 'online';
  const activeFaults = [];

  for (const [, rec] of _registry) {
    if (!rec.deviceIds.includes(deviceId)) continue;

    const cat = FAULT_CATALOGUE[rec.type];
    if (!cat) continue;

    // Respect kind restriction
    if (cat.kinds && !cat.kinds.includes(kind)) continue;

    // Compute ramp progress (0→1) and recovery factor (1→0)
    let rampPct = 1;
    if (rec.status === 'ramping' && rec._rampMs > 0) {
      rampPct = Math.min(1, rec._rampElapsed / rec._rampMs);
    } else if (rec.status === 'recovering') {
      rampPct = Math.max(0, 1 - rec._recoverMs / rec._recoverTotal);
    }

    // Special-case status faults
    if (rec.type === 'sensor_offline') {
      status = 'fault';
      activeFaults.push(rec);
      continue;
    }
    if (rec.type === 'missing_heartbeat') {
      status = 'offline';
      activeFaults.push(rec);
      continue;
    }

    // Apply value transformation
    values = cat.apply(values, kind, rec.severity, rampPct, rand, baseline);
    activeFaults.push(rec);
  }

  // Round all numeric values to 2 decimal places for cleanliness
  const rounded = {};
  for (const [k, v] of Object.entries(values)) {
    rounded[k] = typeof v === 'number' ? parseFloat(v.toFixed(2)) : v;
  }

  const isAnomaly = activeFaults.length > 0;
  const meta = {
    isAnomaly,
    faultIds:   isAnomaly ? activeFaults.map(f => f.id) : [],
    faultTypes: isAnomaly ? [...new Set(activeFaults.map(f => f.type))] : [],
  };

  if (activeFaults.length > 0 && status === 'online') {
    status = 'fault';
  }

  return { values: rounded, status, meta };
}

/**
 * Check if a device has any active attack-type faults.
 * Used by the engine to decide special behaviour (freeze, flood, etc.)
 * @param {string} deviceId
 * @returns {string[]} Array of active attack fault types for this device
 */
function getAttackFaults(deviceId) {
  const attackTypes = new Set([
    'spoofed_sensor', 'replay_attack', 'out_of_range',
    'value_injection', 'duplicate_flood', 'clock_skew',
    'missing_heartbeat', 'stuck_value',
  ]);
  const result = [];
  for (const [, rec] of _registry) {
    if (!rec.deviceIds.includes(deviceId)) continue;
    if ((rec.status === 'active' || rec.status === 'ramping') && attackTypes.has(rec.type)) {
      result.push(rec.type);
    }
  }
  return result;
}

/** Get all active + ramping + recovering faults (not cleared ones). */
function getActive() {
  return [..._registry.values()];
}

/** Get the full fault history log (for ground-truth comparison). */
function getLog() {
  return _log.map(entry => {
    // Return a clean copy (strip internal _fields)
    const { _rampMs, _rampElapsed, _durationMs, _activeMs, _recoverMs, _recoverTotal, _redacted, ...clean } = entry;
    return clean;
  });
}

/** List of all valid fault type names. */
function listTypes() {
  return Object.entries(FAULT_CATALOGUE).map(([type, cat]) => ({
    type,
    description: cat.describe,
    kinds:       cat.kinds || ['power_meter', 'water_tank', 'waste_bin', 'waste_compactor'],
  }));
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _updateLog(rec) {
  // Find the log entry and update it in place
  const idx = _log.findIndex(e => e.id === rec.id);
  if (idx !== -1) {
    _log[idx] = { ..._log[idx], status: rec.status, clearedAt: rec.clearedAt };
  }
}

module.exports = {
  FAULT_CATALOGUE,
  inject,
  clear,
  clearAll,
  tick,
  apply,
  getActive,
  getLog,
  getAttackFaults,
  listTypes,
};
