/**
 * trainer.js — Per-Sensor Model Training & Dataset Ingestion Engine
 * ─────────────────────────────────────────────────────────────
 * Provides:
 * 1. CSV Telemetry Parser (standardizes 18-column SCADA & PZEM-004T logs)
 * 2. Per-Sensor Model Training (Isolation Forest + Robust MAD baselines)
 * 3. Batch Multi-Sensor Training (CSV or JSON dataset onboarding)
 * 4. Model Registry & Calibration State Persistence
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const IsolationForest = require('./isolation_forest');

// In-memory registry of trained sensor models: Map<deviceId, CalibrationRecord>
const sensorCalibrations = new Map();

/**
 * Robust median calculation.
 */
function calculateMedian(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Robust Median Absolute Deviation (MAD).
 * MAD = median(|X - median(X)|)
 */
function calculateMad(values, median) {
  if (!values || values.length === 0) return 1.0;
  const deviations = values.map(v => Math.abs(v - median));
  const rawMad = calculateMedian(deviations);
  // Ensure non-zero MAD to prevent division by zero in Z-Score
  return Math.max(0.1, Number(rawMad.toFixed(3)));
}

/**
 * Parses raw CSV telemetry string into array of normalized JS objects.
 * Handles commas, quotes, whitespace, and flexible header naming.
 * @param {string} csvText
 * @returns {Array<Object>}
 */
function parseTelemetryCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];

  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Parse header line
  const headerLine = lines[0];
  const headers = splitCsvRow(headerLine).map(h => normalizeHeader(h));

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const rowValues = splitCsvRow(lines[i]);
    if (rowValues.length === 0) continue;

    const record = {};
    for (let col = 0; col < headers.length; col++) {
      const key = headers[col];
      let val = rowValues[col] !== undefined ? rowValues[col].trim() : '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      record[key] = val;
    }

    // Coerce numeric fields
    const parsed = normalizeTelemetryRecord(record);
    if (parsed) records.push(parsed);
  }

  return records;
}

/**
 * Helper to split CSV line accounting for quoted commas.
 */
function splitCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Normalizes header keys to standard names.
 */
function normalizeHeader(h) {
  const clean = h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (clean.includes('device') || clean.includes('node')) return 'device_id';
  if (clean.includes('sensor')) return 'sensor_id';
  if (clean.includes('voltage') || clean === 'v') return 'voltage_v';
  if (clean.includes('current') || clean === 'a' || clean === 'amp') return 'current_a';
  if (clean.includes('active_power') || clean === 'power_kw' || clean === 'kw') return 'active_power_kw';
  if (clean.includes('power') || clean === 'w' || clean === 'watts') return 'power';
  if (clean.includes('apparent')) return 'apparent_power_kva';
  if (clean.includes('factor') || clean === 'pf') return 'power_factor';
  if (clean.includes('freq') || clean === 'hz') return 'frequency_hz';
  if (clean.includes('energy') || clean === 'kwh') return 'cumulative_energy_kwh';
  if (clean.includes('timestamp') || clean === 'ts' || clean === 'time') return 'timestamp';
  if (clean.includes('facility')) return 'facility';
  if (clean.includes('label') || clean.includes('building')) return 'building_label';
  return clean;
}

/**
 * Normalizes record data values and formats numbers.
 */
function normalizeTelemetryRecord(raw) {
  const device_id = raw.device_id || raw.deviceId || raw.device || raw.id;
  const voltage = parseFloat(raw.voltage_v || raw.voltage || 230.0);
  const current = parseFloat(raw.current_a || raw.current || 0.0);
  
  let powerKw = raw.active_power_kw !== undefined ? parseFloat(raw.active_power_kw) : undefined;
  if (powerKw === undefined || isNaN(powerKw)) {
    if (raw.power !== undefined) {
      const p = parseFloat(raw.power);
      powerKw = p > 200 ? p / 1000.0 : p; // Auto-detect Watts vs kW
    } else {
      powerKw = (voltage * current * (parseFloat(raw.power_factor || 0.95))) / 1000.0;
    }
  }

  const pf = parseFloat(raw.power_factor || raw.pf || 0.95);
  const hz = parseFloat(raw.frequency_hz || raw.frequency || 50.0);
  const energy = parseFloat(raw.cumulative_energy_kwh || raw.energy || 0.0);

  return {
    device_id: device_id || undefined,
    sensor_id: raw.sensor_id || undefined,
    timestamp: raw.timestamp || raw.timestamp_ist || new Date().toISOString(),
    voltage: isNaN(voltage) ? 230.0 : voltage,
    current: isNaN(current) ? 1.0 : current,
    power_kw: isNaN(powerKw) ? 5.0 : Number(powerKw.toFixed(2)),
    power_factor: isNaN(pf) ? 0.95 : pf,
    frequency: isNaN(hz) ? 50.0 : hz,
    energy_kwh: isNaN(energy) ? 0.0 : energy,
    facility: raw.facility || undefined,
    label: raw.building_label || raw.label || undefined
  };
}

/**
 * Trains/calibrates an individual sensor model on an array of telemetry points.
 * @param {string} deviceId - Target sensor identifier
 * @param {Array<Object>} records - Telemetry array
 * @param {Object} options - { source, label, facility }
 * @returns {Object} Public calibration summary
 */
function trainSensorModel(deviceId, records = [], options = {}) {
  if (!deviceId) throw new Error('Missing deviceId for sensor training');
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Cannot train ${deviceId}: No telemetry samples provided`);
  }

  // Filter for this device if records contain mixed sensors
  const relevant = records.filter(r => !r.device_id || r.device_id === deviceId);
  const pool = relevant.length > 0 ? relevant : records;

  const kwValues = [];
  const featureVectors = [];

  for (const r of pool) {
    const v = r.voltage !== undefined ? r.voltage : 230.0;
    const a = r.current !== undefined ? r.current : 2.0;
    let kw = r.power_kw !== undefined ? r.power_kw : undefined;
    if (kw === undefined && r.power !== undefined) {
      kw = r.power > 200 ? r.power / 1000.0 : r.power;
    }
    if (kw === undefined) kw = (v * a * 0.95) / 1000.0;

    const pf = r.power_factor !== undefined ? r.power_factor : 0.95;
    const hz = r.frequency !== undefined ? r.frequency : 50.0;

    kwValues.push(kw);
    featureVectors.push([v, a, kw, pf, hz]);
  }

  // Compute robust central tendency and scale
  const median = calculateMedian(kwValues);
  const mad = calculateMad(kwValues, median);
  const kSigma = 3.5;
  const upperThresholdKw = Number((median + (kSigma * 1.4826 * mad)).toFixed(2));
  const lowerThresholdKw = Number(Math.max(0, median - (kSigma * 1.4826 * mad)).toFixed(2));

  // Fit dedicated Multivariate Isolation Forest
  const nTrees = 60;
  const subsampleSize = Math.min(128, featureVectors.length);
  const iForest = new IsolationForest({ nTrees, subsampleSize, threshold: 0.60 });
  iForest.fit(featureVectors);

  const calibration = {
    deviceId,
    sensorId: options.sensorId || `PZEM_004T_${deviceId}`,
    label: options.label || deviceId,
    facility: options.facility || 'college',
    isCalibrated: true,
    sampleCount: featureVectors.length,
    median: Number(median.toFixed(2)),
    mad: Number(mad.toFixed(2)),
    thresholdSigma: kSigma,
    upperThresholdKw,
    lowerThresholdKw,
    iForest,
    treesFitted: nTrees,
    trainedAt: new Date().toISOString(),
    source: options.source || 'user_upload'
  };

  sensorCalibrations.set(deviceId, calibration);

  // Return JSON-safe representation (without iForest instance)
  return getPublicCalibration(calibration);
}

/**
 * Returns JSON-safe calibration object without recursive object refs.
 */
function getPublicCalibration(cal) {
  if (!cal) return null;
  return {
    deviceId: cal.deviceId,
    sensorId: cal.sensorId,
    label: cal.label,
    facility: cal.facility,
    isCalibrated: Boolean(cal.isCalibrated),
    sampleCount: cal.sampleCount,
    median: cal.median,
    mad: cal.mad,
    thresholdSigma: cal.thresholdSigma,
    upperThresholdKw: cal.upperThresholdKw,
    lowerThresholdKw: cal.lowerThresholdKw,
    treesFitted: cal.treesFitted,
    trainedAt: cal.trainedAt,
    source: cal.source
  };
}

/**
 * Trains multiple sensors at once from a batch dataset.
 * Supports:
 * - Object keyed by deviceId: { ESP32_HA_F1: { points: [...] } }
 * - Array of records with `device_id` column
 * - CSV string with `device_id` column
 * @param {Object|Array|string} dataset
 * @param {Object} options
 * @returns {Array<Object>} List of trained sensor summaries
 */
function trainBatchSensors(dataset, options = {}) {
  const results = [];

  // Case 1: CSV string
  if (typeof dataset === 'string') {
    const records = parseTelemetryCsv(dataset);
    if (records.length === 0) {
      throw new Error('CSV file contained no valid telemetry records');
    }
    // Group records by device_id
    const grouped = {};
    for (const r of records) {
      const dev = r.device_id || options.defaultDeviceId || 'ESP32_GENERIC';
      if (!grouped[dev]) grouped[dev] = [];
      grouped[dev].push(r);
    }

    for (const [devId, rows] of Object.entries(grouped)) {
      const cal = trainSensorModel(devId, rows, {
        source: options.source || 'batch_csv_upload',
        label: rows[0]?.label,
        facility: rows[0]?.facility
      });
      results.push(cal);
    }
    return results;
  }

  // Case 2: Object keyed by deviceId (like training_baseline_3months_all_sensors.json)
  if (dataset && typeof dataset === 'object' && !Array.isArray(dataset)) {
    // Check if it's { data: [...] } or { sensors: {...} } wrapper
    if (Array.isArray(dataset.records) || Array.isArray(dataset.data)) {
      return trainBatchSensors(dataset.records || dataset.data, options);
    }
    if (typeof dataset.csv === 'string') {
      return trainBatchSensors(dataset.csv, options);
    }

    for (const [devId, nodeObj] of Object.entries(dataset)) {
      const points = Array.isArray(nodeObj)
        ? nodeObj
        : (nodeObj?.points || nodeObj?.records || []);
      if (points.length > 0) {
        const cal = trainSensorModel(devId, points, {
          source: options.source || 'batch_json_all_sensors',
          label: nodeObj?.label,
          facility: nodeObj?.facility,
          sensorId: nodeObj?.sensor_id
        });
        results.push(cal);
      }
    }
    return results;
  }

  // Case 3: Flat array of records
  if (Array.isArray(dataset)) {
    const grouped = {};
    for (const r of dataset) {
      const dev = r.device_id || r.deviceId || options.defaultDeviceId || 'ESP32_GENERIC';
      if (!grouped[dev]) grouped[dev] = [];
      grouped[dev].push(r);
    }
    for (const [devId, rows] of Object.entries(grouped)) {
      const cal = trainSensorModel(devId, rows, {
        source: options.source || 'batch_json_array'
      });
      results.push(cal);
    }
    return results;
  }

  throw new Error('Unsupported dataset format for batch sensor training');
}

/**
 * Gets the active trained model instance for a sensor (includes iForest).
 */
function getSensorModel(deviceId) {
  if (!deviceId) return null;
  return sensorCalibrations.get(deviceId) || null;
}

/**
 * Gets public calibration status for a specific sensor.
 */
function getSensorCalibration(deviceId) {
  const model = getSensorModel(deviceId);
  return model ? getPublicCalibration(model) : null;
}

/**
 * Gets all public calibrations across all sensors.
 */
function getAllSensorCalibrations() {
  const result = {};
  for (const [deviceId, cal] of sensorCalibrations.entries()) {
    result[deviceId] = getPublicCalibration(cal);
  }
  return result;
}

/**
 * Auto-initializes the baseline models for all 12 sensors on server startup
 * using the built-in 90-day baseline dataset if available.
 */
function initBaselineModels() {
  try {
    const allJsonPath = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months_all_sensors.json');
    if (fs.existsSync(allJsonPath)) {
      const raw = fs.readFileSync(allJsonPath, 'utf8');
      const data = JSON.parse(raw);
      const res = trainBatchSensors(data, { source: 'system_90day_baseline_dataset' });
      console.log(`[trainer] Initialized ${res.length} sensor models with 90-day baseline telemetry`);
      return res;
    }
  } catch (err) {
    console.warn('[trainer] Baseline auto-init note:', err.message);
  }
  return [];
}

// Auto-run initialization so the 12 existing sensors start calibrated
initBaselineModels();

module.exports = {
  trainSensorModel,
  trainBatchSensors,
  getSensorModel,
  getSensorCalibration,
  getAllSensorCalibrations,
  parseTelemetryCsv,
  initBaselineModels
};
