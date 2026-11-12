/**
 * hardware.js — Hardware Node Simulation & Telemetry Inspector Routes
 * ─────────────────────────────────────────────────────────────
 * GET   /api/hardware/nodes       List all ESP32+PZEM-004T hardware nodes with org_id, device_id, secret_key
 * GET   /api/hardware/:id/packet  Get live signed hardware JSON packet for device
 * POST  /api/hardware/:id/inject  Start live custom/high usage register injection
 * POST  /api/hardware/:id/reset   Stop live injection and restore nominal profile
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const { resolveOperator } = require('../middleware/auth');

const router = express.Router();

router.use(resolveOperator);

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

module.exports = router;
