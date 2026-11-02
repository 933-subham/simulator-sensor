/**
 * devices.js — Device management routes
 * ─────────────────────────────────────────────────────────────
 * POST   /api/devices         Create one or many devices
 * GET    /api/devices         List all (no secrets ever returned)
 * PATCH  /api/devices/:id     Update label
 * DELETE /api/devices/:id     Remove device + its history
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const engine  = require('../simulator/engine');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// All device-management endpoints require the API key
router.use(requireApiKey);

// ── POST /api/devices ────────────────────────────────────────────────────────

/**
 * Create one or more new devices.
 *
 * Request body:
 * {
 *   "kind":          "power_meter" | "water_tank",   (required)
 *   "label":         "Building A - Floor 2",          (optional)
 *   "buildingType":  "hostel" | "academic" | "labs" | "library",  (optional, default academic)
 *   "count":         3                                (optional, creates N devices)
 * }
 *
 * Response:
 * [{ deviceId, kind, label, claimCode }]   ← claimCode shown here; secret via POST /api/claim
 */
router.post('/', (req, res) => {
  const { kind, label, buildingType, count } = req.body || {};

  const VALID_KINDS  = ['power_meter', 'water_tank'];
  const VALID_BUILDS = ['hostel', 'academic', 'labs', 'library'];

  if (!kind || !VALID_KINDS.includes(kind)) {
    return res.status(400).json({
      error: `"kind" is required and must be one of: ${VALID_KINDS.join(', ')}`,
    });
  }

  const n = Math.min(parseInt(count, 10) || 1, 20); // max 20 at once
  const created = [];

  for (let i = 0; i < n; i++) {
    const deviceId = 'dev-' + crypto.randomBytes(4).toString('hex');
    const lbl = n > 1 && label ? `${label} #${i + 1}` : (label || deviceId);

    const record = engine.registerDevice({
      deviceId,
      kind,
      label: lbl,
      buildingType: VALID_BUILDS.includes(buildingType) ? buildingType : 'academic',
    });

    // Return claimCode but NOT the secret — secret is obtained via POST /api/claim
    created.push({
      deviceId:    record.deviceId,
      kind:        record.kind,
      label:       record.label,
      buildingType: record.buildingType,
      claimCode:   record.claimCode,
      createdAt:   record.createdAt,
    });
  }

  res.status(201).json(created.length === 1 ? created[0] : created);
});

// ── GET /api/devices ─────────────────────────────────────────────────────────

/**
 * List all registered devices.
 * Secrets are NEVER included. claimCode is shown only while unclaimed.
 */
router.get('/', (req, res) => {
  res.json(engine.listDevices());
});

// ── PATCH /api/devices/:id ───────────────────────────────────────────────────

/** Update a device's label. */
router.patch('/:id', (req, res) => {
  const device = engine.getDeviceRaw(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const { label } = req.body || {};
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: '"label" string is required' });
  }

  device.label = label.trim().slice(0, 120);
  res.json({ deviceId: device.deviceId, label: device.label });
});

// ── DELETE /api/devices/:id ──────────────────────────────────────────────────

/** Remove a device and all its history. */
router.delete('/:id', (req, res) => {
  const removed = engine.removeDevice(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Device not found' });
  res.json({ removed: req.params.id });
});

module.exports = router;
