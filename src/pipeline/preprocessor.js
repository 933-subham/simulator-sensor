/**
 * preprocessor.js — Ingestion, Preprocessing & Dual-Model Anomaly Detection Pipeline
 * ─────────────────────────────────────────────────────────────
 * Integrates:
 * 1. Hardware JSON Preprocessing into 18-Column SCADA standard
 * 2. Model A: Robust Z-Score (MAD) for temporal load deviations
 * 3. Model B: Multivariate Isolation Forest for multidimensional (V, I, P, PF, Hz) correlation anomalies
 * 4. Ensemble Fusion: Combines both models with confidence scoring and physical diagnosis
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const IsolationForest = require('./isolation_forest');
const { getSensorModel } = require('./trainer');

// Sensor facility and building metadata lookup
const SENSOR_METADATA = {
  'ESP32_HA_F1': { label: 'Building A - Floor 1', facility: 'hostel' },
  'ESP32_HA_F2': { label: 'Building A - Floor 2', facility: 'hostel' },
  'ESP32_HA_F3': { label: 'Building A - Floor 3', facility: 'hostel' },
  'ESP32_HA_F4': { label: 'Building A - Floor 4', facility: 'hostel' },
  'ESP32_AB_F1': { label: 'Academic Block - Wing A', facility: 'college' },
  'ESP32_AB_F2': { label: 'Academic Block - Wing B', facility: 'college' },
  'ESP32_AUDIT': { label: 'Academic Block - Auditorium', facility: 'college' },
  'ESP32_LIB_F1': { label: 'Library - Main Hall', facility: 'college' },
  'ESP32_LIB_F2': { label: 'Library - Study Wing', facility: 'college' },
  'ESP32_LAB_CHEM': { label: 'Labs - Chemistry Lab', facility: 'college' },
  'ESP32_LAB_PHY': { label: 'Labs - Physics Lab', facility: 'college' },
  'ESP32_LAB_BIO': { label: 'Labs - Biology / Biotech Lab', facility: 'college' }
};

// Facility baseline parameters for Robust Z-Score (Median Absolute Deviation)
const FACILITY_BASELINES = {
  hostel:  { median: 18.5, mad: 1.85 },
  college: { median: 22.0, mad: 2.20 },
  lab:     { median: 24.0, mad: 2.40 }
};

// Initialize and train the pure-JS Multivariate Isolation Forest on nominal baseline cluster
const iForest = new IsolationForest({ nTrees: 60, subsampleSize: 128, threshold: 0.60 });

// Seed 600 baseline nominal samples [voltage, current, power_kw, power_factor, frequency]
const nominalSeedCluster = [];
for (let i = 0; i < 600; i++) {
  const v = 230 + (Math.random() * 8 - 4);
  const pf = 0.92 + (Math.random() * 0.06);
  const kw = 14 + Math.random() * 22;
  const a = (kw * 1000) / (v * pf);
  const hz = 50 + (Math.random() * 0.2 - 0.1);
  nominalSeedCluster.push([v, a, kw, pf, hz]);
}
iForest.fit(nominalSeedCluster);

/**
 * Model A: Computes Robust Z-Score using Median Absolute Deviation (MAD).
 * Formula: Z = (P - median) / (1.4826 * MAD)
 */
function computeRobustZScore(powerKw, facilityType = 'college') {
  const base = FACILITY_BASELINES[facilityType] || FACILITY_BASELINES.college;
  const z = (powerKw - base.median) / (1.4826 * base.mad);
  const isAnomaly = Math.abs(z) > 3.5;
  return {
    z_score: Number(z.toFixed(2)),
    threshold: 3.5,
    isAnomaly
  };
}

/**
 * Model B: Evaluates Multivariate Isolation Forest on 5D electrical manifold:
 * [voltage_v, current_a, active_power_kw, power_factor, frequency_hz]
 */
function computeIsolationForest(record) {
  return iForest.predict(record);
}

/**
 * Ensemble Fusion: Evaluates BOTH Robust Z-Score and Isolation Forest.
 * @param {Object} preprocessed - Standardized 18-column record
 * @returns {Object} Ensemble verdict, individual model scores, and diagnosis
 */
function detectEnsembleAnomaly(preprocessed) {
  const sensorModel = getSensorModel(preprocessed.device_id);
  let isCalibrated = false;

  let zRes;
  let ifRes;

  if (sensorModel && sensorModel.isCalibrated) {
    isCalibrated = true;
    // 1. Sensor-specific Robust Z-Score (tuned to this physical transducer's exact baseline)
    const z = (preprocessed.active_power_kw - sensorModel.median) / (1.4826 * sensorModel.mad);
    const isZAnomaly = Math.abs(z) > sensorModel.thresholdSigma;
    zRes = {
      z_score: Number(z.toFixed(2)),
      threshold: sensorModel.thresholdSigma,
      isAnomaly: isZAnomaly,
      median: sensorModel.median,
      mad: sensorModel.mad,
      calibrated: true
    };

    // 2. Sensor-specific Isolation Forest (evaluated against this sensor's 5D manifold)
    ifRes = sensorModel.iForest.predict(preprocessed);
  } else {
    // Fallback: Model A: Robust Z-Score (Temporal load magnitude on generic facility)
    zRes = computeRobustZScore(preprocessed.active_power_kw, preprocessed.facility_type);

    // Fallback: Model B: Isolation Forest (Generic 5D cluster)
    ifRes = computeIsolationForest(preprocessed);
  }

  // 3. Fusion Logic
  const isAnomaly = zRes.isAnomaly || ifRes.isAnomaly;
  const confidencePct = isAnomaly
    ? Number(Math.min(99.9, 91.0 + Math.max(Math.abs(zRes.z_score) * 1.5, ifRes.anomalyScore * 12)).toFixed(1))
    : Number(Math.max(92.0, 98.5 - Math.abs(zRes.z_score) * 2).toFixed(1));

  let diagnosis = isCalibrated
    ? `Nominal electrical operation within sensor ${preprocessed.device_id}'s learned baseline envelope (Median: ${zRes.median || 20} kW, MAD: ${zRes.mad || 2} kW).`
    : 'Nominal electrical operation within learned statistical clusters.';
  let rootCause = 'nominal';

  if (zRes.isAnomaly && ifRes.isAnomaly) {
    diagnosis = `Compound Critical Anomaly: Both Robust Z-Score (${zRes.z_score}σ) and Isolation Forest (${ifRes.anomalyScore}) triggered simultaneously. Severe active power and electrical distortion.`;
    rootCause = 'compound_severe_overload';
  } else if (zRes.isAnomaly) {
    diagnosis = `Temporal Load Anomaly: Robust Z-Score (${zRes.z_score}σ > ${zRes.threshold || 3.5}σ) flagged active power spike/surge exceeding ${isCalibrated ? preprocessed.device_id + '\'s calibrated' : 'facility'} capacity.`;
    rootCause = 'temporal_power_surge';
  } else if (ifRes.isAnomaly) {
    diagnosis = `Multivariate Correlation Fault: Isolation Forest (${ifRes.anomalyScore} > 0.60) detected anomalous Voltage/Current/PF phase correlation.`;
    rootCause = 'multivariate_electrical_distortion';
  }

  return {
    ensemble_verdict: isAnomaly ? 'ANOMALY_DETECTED' : 'NORMAL',
    is_anomaly: isAnomaly,
    confidence_pct: confidencePct,
    root_cause: rootCause,
    calibrated: isCalibrated,
    models: {
      robust_z_score: {
        score: zRes.z_score,
        threshold: zRes.threshold || 3.5,
        unit: 'sigma (MAD)',
        flag: zRes.isAnomaly,
        calibrated: isCalibrated,
        median: zRes.median,
        mad: zRes.mad
      },
      isolation_forest: {
        score: ifRes.anomalyScore,
        threshold: 0.60,
        unit: 'anomaly_score (0.0 to 1.0)',
        avg_path_length: ifRes.avgPathLength,
        flag: ifRes.isAnomaly,
        calibrated: isCalibrated
      }
    },
    diagnosis
  };
}

/**
 * Preprocesses a raw ESP32 packet into the 18-column ML schema AND runs the Dual-Model Anomaly Detection.
 * @param {Object} rawPacket - Raw JSON packet from ESP32
 * @param {Object} options - { isAnomaly, customMeta }
 * @returns {Object} Preprocessed record with attached ensemble anomaly evaluation
 */
function preprocessHardwarePacket(rawPacket = {}, options = {}) {
  const deviceId = rawPacket.device_id || rawPacket.deviceId || 'ESP32_GENERIC';
  const sensorId = rawPacket.sensor_id || rawPacket.sensorId || `PZEM_004T_${deviceId}`;

  // 1. Resolve building and facility metadata
  const meta = SENSOR_METADATA[deviceId] || {
    label: rawPacket.label || deviceId,
    facility: rawPacket.facility || 'college'
  };

  // 2. Parse and normalize timestamps
  const rawTs = rawPacket.timestamp || new Date().toISOString();
  const dateObj = new Date(rawTs);
  const isValidDate = !isNaN(dateObj.getTime());
  const validDate = isValidDate ? dateObj : new Date();

  // Generate IST string (+05:30)
  const istOffsetMs = 5.5 * 3600 * 1000;
  const istDate = new Date(validDate.getTime() + istOffsetMs);
  const timestampIst = istDate.toISOString().replace('Z', '+05:30');
  const timestampIso = validDate.toISOString();

  // 3. Extract temporal cyclical features
  const hourOfDay = istDate.getUTCHours();
  const dayOfWeek = istDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0;

  // 4. Physical electrical register parsing & unit conversion
  const voltageV = typeof rawPacket.voltage === 'number' ? Number(rawPacket.voltage.toFixed(1)) : parseFloat(rawPacket.voltage || 230.0);
  const currentA = typeof rawPacket.current === 'number' ? Number(rawPacket.current.toFixed(3)) : parseFloat(rawPacket.current || 0.0);
  
  // Power conversion: Transducer sends raw Watts -> Convert to Kilowatts (kW)
  const rawWatts = typeof rawPacket.power === 'number' ? rawPacket.power : parseFloat(rawPacket.power || 0.0);
  const activePowerKw = Number((rawWatts / 1000.0).toFixed(2));

  const powerFactor = typeof rawPacket.power_factor === 'number' ? Number(rawPacket.power_factor.toFixed(2)) : parseFloat(rawPacket.power_factor || 0.95);
  const frequencyHz = typeof rawPacket.frequency === 'number' ? Number(rawPacket.frequency.toFixed(2)) : parseFloat(rawPacket.frequency || 50.0);
  const cumulativeEnergyKwh = typeof rawPacket.energy === 'number' ? Number(rawPacket.energy.toFixed(3)) : parseFloat(rawPacket.energy || 0.0);

  // Derived electrical metric: Apparent Power S = P / PF (in kVA)
  const pfSafe = Math.max(0.1, powerFactor);
  const apparentPowerKva = Number((activePowerKw / pfSafe).toFixed(2));

  const isAnomalyGroundTruth = options.isAnomaly ? 1 : 0;
  const signature = rawPacket.signature || '';

  // 5. Construct standardized 18-column record
  const preprocessed = {
    timestamp_ist: timestampIst,
    timestamp_iso: timestampIso,
    device_id: deviceId,
    sensor_id: sensorId,
    building_label: meta.label,
    facility_type: meta.facility,
    voltage_v: voltageV,
    current_a: currentA,
    active_power_kw: activePowerKw,
    apparent_power_kva: apparentPowerKva,
    power_factor: powerFactor,
    frequency_hz: frequencyHz,
    cumulative_energy_kwh: cumulativeEnergyKwh,
    hour_of_day: hourOfDay,
    day_of_week: dayOfWeek,
    is_weekend: isWeekend,
    is_anomaly_ground_truth: isAnomalyGroundTruth,
    hmac_sha256_signature: signature
  };

  // 6. Execute Dual-Model Anomaly Detection (Robust Z-Score + Isolation Forest)
  const anomalyVerdict = detectEnsembleAnomaly(preprocessed);
  preprocessed.anomaly_detection = anomalyVerdict;

  return preprocessed;
}

/**
 * Converts a preprocessed object into a CSV row string.
 * @param {Object} item 
 * @returns {string} CSV formatted row
 */
function toCsvRow(item) {
  return [
    `"${item.timestamp_ist}"`,
    `"${item.timestamp_iso}"`,
    `"${item.device_id}"`,
    `"${item.sensor_id}"`,
    `"${item.building_label}"`,
    `"${item.facility_type}"`,
    item.voltage_v,
    item.current_a,
    item.active_power_kw,
    item.apparent_power_kva,
    item.power_factor,
    item.frequency_hz,
    item.cumulative_energy_kwh,
    item.hour_of_day,
    item.day_of_week,
    item.is_weekend,
    item.is_anomaly_ground_truth,
    `"${item.hmac_sha256_signature}"`
  ].join(',');
}

module.exports = {
  preprocessHardwarePacket,
  detectEnsembleAnomaly,
  computeRobustZScore,
  computeIsolationForest,
  toCsvRow,
  iForest,
  SENSOR_METADATA
};
