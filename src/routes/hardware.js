/**
 * hardware.js — Hardware Node Simulation & Telemetry Inspector Routes
 * ─────────────────────────────────────────────────────────────
 * GET   /api/hardware/nodes            List all ESP32+PZEM-004T hardware nodes with org_id, device_id, secret_key
 * GET   /api/hardware/:id/packet       Get live signed hardware JSON packet for device
 * POST  /api/hardware/:id/inject       Start live custom/high usage register injection
 * POST  /api/hardware/:id/reset        Stop live injection/stream and restore nominal profile
 * POST  /api/hardware/:id/stream       Stream uploaded JSON frames sequence (tick by tick every 2s)
 * POST  /api/hardware/:id/stream/stop  Stop active JSON streaming playback
 * GET   /api/hardware/:id/stream       Get stream queue playback status
 * GET   /api/hardware/presets/test-fault-24h     Download/inspect 24-frame fault test sequence
 * GET   /api/hardware/presets/baseline-3months   Download/inspect 90-day baseline dataset summary
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const engine  = require('../simulator/engine');
const { resolveOperator } = require('../middleware/auth');
const { preprocessHardwarePacket, toCsvRow } = require('../pipeline/preprocessor');
const {
  trainSensorModel,
  trainBatchSensors,
  getSensorCalibration,
  getAllSensorCalibrations,
  parseTelemetryCsv
} = require('../pipeline/trainer');

const router = express.Router();

router.use(resolveOperator);

/**
 * GET /api/hardware/presets/test-fault-24h
 * Returns pre-built 24h fault test sequence JSON array.
 */
router.get('/presets/test-fault-24h', (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'datasets', 'test_fault_24h.json');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Preset test_fault_24h.json not found' });
  }
});

/**
 * GET /api/hardware/presets/baseline-3months
 * Returns pre-built 3-month baseline training dataset JSON array.
 */
router.get('/presets/baseline-3months', (req, res) => {
  const allJson = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months_all_sensors.json');
  const singleJson = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months.json');
  const target = fs.existsSync(allJson) ? allJson : singleJson;
  if (fs.existsSync(target)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="training_baseline_3months.json"');
    res.sendFile(target);
  } else {
    res.status(404).json({ error: 'Preset training_baseline_3months.json not found' });
  }
});

/**
 * GET /api/hardware/presets/baseline-3months-csv
 * Returns 90-day (3-month) 25,920-row CSV training dataset for Excel / ML presentation.
 */
router.get('/presets/baseline-3months-csv', (req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'datasets', 'greenloop_3month_training_dataset.csv');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="greenloop_3month_training_dataset.csv"');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Preset greenloop_3month_training_dataset.csv not found' });
  }
});

/**
 * POST /api/hardware/preprocess
 * Transforms a raw ESP32 JSON telemetry packet into the standardized 18-column ML schema.
 */
router.post('/preprocess', (req, res) => {
  const rawPacket = req.body || {};
  if (!rawPacket.device_id && !rawPacket.deviceId) {
    return res.status(400).json({ error: 'Missing device_id in telemetry packet' });
  }
  const preprocessed = preprocessHardwarePacket(rawPacket);
  const csvRow = toCsvRow(preprocessed);
  res.json({
    ok: true,
    schema: 'greenloop_18_column_ml_telemetry_standard',
    preprocessed,
    csv_row: csvRow
  });
});

/**
 * POST /api/hardware/ingest
 * Ingests a raw ESP32 packet from physical hardware, verifies signature, preprocesses it, and stores it.
 */
router.post('/ingest', (req, res) => {
  const rawPacket = req.body || {};
  const deviceId = rawPacket.device_id || rawPacket.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing device_id in telemetry packet' });
  }

  const dev = engine.getDeviceByIdOrHwId(deviceId);
  let signatureVerified = false;
  if (dev && dev.secret && rawPacket.signature) {
    const expectedSig = engine.computeHardwareSignature(
      dev.secret,
      dev.device_id || dev.deviceId,
      rawPacket.timestamp,
      rawPacket.voltage,
      rawPacket.current,
      rawPacket.power,
      rawPacket.energy
    );
    signatureVerified = (expectedSig === rawPacket.signature);
  }

  const preprocessed = preprocessHardwarePacket(rawPacket);
  res.status(201).json({
    accepted: true,
    device_id: deviceId,
    signature_verified: signatureVerified,
    preprocessed
  });
});

/**
 * GET /api/hardware/nodes
 * Returns array of hardware nodes for the inspector grid.
 * Each card shows org_id, device_id, secret_key, and active AI calibration metrics.
 */
router.get('/nodes', (req, res) => {
  const nodes = engine.listHardwareNodes();
  const calibrations = getAllSensorCalibrations();
  const enriched = nodes.map(node => {
    const devId = node.device_id || node.deviceId;
    return {
      ...node,
      calibration: calibrations[devId] || { isCalibrated: false }
    };
  });
  res.json(enriched);
});

/**
 * GET /api/hardware/calibrations
 * Returns dictionary of all active sensor calibration profiles.
 */
router.get('/calibrations', (req, res) => {
  res.json(getAllSensorCalibrations());
});

/**
 * GET /api/hardware/:id/calibration
 * Returns calibration profile for a single sensor.
 */
router.get('/:id/calibration', (req, res) => {
  const cal = getSensorCalibration(req.params.id);
  if (!cal) {
    return res.status(404).json({ error: `Sensor ${req.params.id} has not been calibrated yet`, isCalibrated: false });
  }
  res.json(cal);
});

/**
 * POST /api/hardware/:id/train
 * Trains/calibrates an individual sensor on uploaded CSV, JSON records, or built-in 90-day baseline.
 */
router.post('/:id/train', (req, res) => {
  try {
    const deviceId = req.params.id;
    const dev = engine.getDeviceByIdOrHwId(deviceId);
    const targetDevId = dev ? (dev.device_id || dev.deviceId) : deviceId;

    let points = [];
    let source = 'user_upload';

    if (req.body?.usePreset) {
      const allJsonPath = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months_all_sensors.json');
      if (fs.existsSync(allJsonPath)) {
        const allData = JSON.parse(fs.readFileSync(allJsonPath, 'utf8'));
        const nodeObj = allData[targetDevId];
        if (nodeObj && (nodeObj.points || Array.isArray(nodeObj))) {
          points = nodeObj.points || nodeObj;
          source = 'preset_90day_baseline';
        }
      }
      if (points.length === 0) {
        return res.status(404).json({ error: `No 90-day preset dataset found for ${targetDevId}` });
      }
    } else if (typeof req.body?.csv === 'string') {
      points = parseTelemetryCsv(req.body.csv);
      source = 'uploaded_csv';
    } else if (Array.isArray(req.body?.records)) {
      points = req.body.records;
      source = 'uploaded_json_array';
    } else if (Array.isArray(req.body)) {
      points = req.body;
      source = 'uploaded_json_array';
    } else {
      return res.status(400).json({ error: 'Request body must contain { usePreset: true }, { records: [...] }, or { csv: "..." }' });
    }

    if (points.length === 0) {
      return res.status(400).json({ error: 'No valid telemetry samples extracted for training' });
    }

    const calibration = trainSensorModel(targetDevId, points, {
      source,
      label: dev?.label || targetDevId,
      facility: dev?.facility || 'college'
    });

    res.json({
      success: true,
      message: `Model successfully calibrated for ${targetDevId} on ${calibration.sampleCount} samples`,
      calibration
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/hardware/train/batch
 * Trains/calibrates multiple sensors at once from master CSV, multi-sensor JSON, or 90-day campus preset.
 */
router.post('/train/batch', (req, res) => {
  try {
    let dataset;
    let source = 'batch_upload';

    if (req.body?.usePreset) {
      const allJsonPath = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months_all_sensors.json');
      if (fs.existsSync(allJsonPath)) {
        dataset = JSON.parse(fs.readFileSync(allJsonPath, 'utf8'));
        source = 'campus_90day_baseline_preset';
      } else {
        return res.status(404).json({ error: 'Built-in 90-day baseline dataset file not found' });
      }
    } else if (typeof req.body?.csv === 'string') {
      dataset = req.body.csv;
      source = 'batch_csv_upload';
    } else if (req.body?.data) {
      dataset = req.body.data;
      source = 'batch_json_upload';
    } else if (Array.isArray(req.body?.records)) {
      dataset = req.body.records;
      source = 'batch_json_array';
    } else if (req.body && typeof req.body === 'object') {
      dataset = req.body;
    } else {
      return res.status(400).json({ error: 'Request body must contain { usePreset: true }, { csv: "..." }, or { data: ... }' });
    }

    const results = trainBatchSensors(dataset, { source });
    res.json({
      success: true,
      message: `Batch training complete: ${results.length} sensors calibrated`,
      count: results.length,
      results
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/hardware/:id/packet
 * Returns the current live signed hardware packet (ESP32 + PZEM-004T frame).
 */
router.get('/:id/packet', (req, res) => {
  const packet = engine.getDeviceHardwarePacket(req.params.id);
  if (!packet) {
    return res.status(404).json({
      error: 'Hardware node not found or device is not a power meter',
      deviceId: req.params.id,
    });
  }
  res.json(packet);
});

/**
 * POST /api/hardware/:id/inject
 * Starts live injection on a hardware node.
 * Request body:
 * {
 *   "voltage": 230.5,
 *   "current": 14.850,
 *   "power_factor": 0.98,
 *   "frequency": 50.0,
 *   "energy": 12.450
 * }
 */
router.post('/:id/inject', (req, res) => {
  const node = engine.setHardwareInjection(req.params.id, req.body || {});
  if (!node) {
    return res.status(404).json({
      error: 'Hardware node not found or device is not a power meter',
      deviceId: req.params.id,
    });
  }
  res.json({
    success: true,
    message: `Live injection stream active on ${node.device_id}`,
    node,
  });
});

/**
 * POST /api/hardware/:id/stream
 * Starts frame-by-frame streaming of uploaded JSON data.
 * Body can be: { frames: [...], loop: boolean } OR an array [...]
 */
router.post('/:id/stream', (req, res) => {
  try {
    const body = req.body || {};
    const frames = Array.isArray(body) ? body : (body.frames || []);
    const loop = Boolean(body.loop);
    const node = engine.startHardwareStream(req.params.id, frames, { loop });
    if (!node) {
      return res.status(404).json({
        error: 'Hardware node not found or device is not a power meter',
        deviceId: req.params.id,
      });
    }
    res.json({
      success: true,
      message: `JSON stream active on ${node.device_id} (${frames.length} frames queued)`,
      streamStatus: node.streamStatus,
      node,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/hardware/:id/stream/stop
 * Stops active JSON streaming on a node and restores normal simulation.
 */
router.post('/:id/stream/stop', (req, res) => {
  const ok = engine.stopHardwareStream(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Hardware node not found' });
  }
  res.json({
    success: true,
    message: 'JSON stream stopped — returned to normal simulation',
  });
});

/**
 * GET /api/hardware/:id/stream
 * Get current stream playback status.
 */
router.get('/:id/stream', (req, res) => {
  const status = engine.getHardwareStreamStatus(req.params.id);
  if (!status) {
    return res.status(404).json({ error: 'Hardware node not found' });
  }
  res.json(status);
});

/**
 * POST /api/hardware/:id/reset
 * Resets live injection and returns node to nominal campus load pattern.
 */
router.post('/:id/reset', (req, res) => {
  const ok = engine.clearHardwareInjection(req.params.id);
  if (!ok) {
    return res.status(404).json({
      error: 'Hardware node not found or device is not a power meter',
      deviceId: req.params.id,
    });
  }
  res.json({
    success: true,
    message: 'Live injection stream stopped — restored to nominal profile',
  });
});

/**
 * POST /api/hardware/add
 * Dynamically provision a new ESP32 + PZEM-004T hardware sensor node.
 * Request body: { org_id, device_id, sensor_id, label, secret_key, power_kw, voltage }
 */
router.post('/add', (req, res) => {
  try {
    const node = engine.addHardwareNode(req.body || {});
    res.json({
      success: true,
      message: `Node ${node.device_id} successfully provisioned`,
      node,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/hardware/:id
 * Remove a hardware sensor node.
 */
router.delete('/:id', (req, res) => {
  const ok = engine.deleteHardwareNode(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Hardware node not found' });
  }
  res.json({
    success: true,
    message: `Node ${req.params.id} deleted successfully`,
  });
});

module.exports = router;
