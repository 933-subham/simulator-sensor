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
  const filePath = path.join(__dirname, '..', '..', 'datasets', 'training_baseline_3months.json');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Preset training_baseline_3months.json not found' });
  }
});

/**
 * GET /api/hardware/nodes
 * Returns array of hardware nodes for the inspector grid.
 * Each card shows org_id, device_id, secret_key.
 */
router.get('/nodes', (req, res) => {
  const nodes = engine.listHardwareNodes();
  res.json(nodes);
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
