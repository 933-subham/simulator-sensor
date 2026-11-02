/**
 * push.js — POST /api/push/:deviceId
 * ─────────────────────────────────────────────────────────────
 * Accepts signed readings from external (real) devices.
 *
 * The global API key is NOT required here — instead, each device
 * authenticates with its own HMAC secret obtained via /api/claim.
 *
 * Required headers:
 *   x-device-id    The device ID (must match the URL param)
 *   x-timestamp    ISO 8601 timestamp of the reading
 *   x-seq          Sequence number (integer, strictly increasing)
 *   x-signature    HMAC-SHA256(secret, deviceId.timestamp.seq.canonicalJson(values))
 *
 * Security properties enforced:
 *   • Unknown device ID          → 401
 *   • Timestamp older than 60 s  → 401 (replay prevention)
 *   • Timestamp in the future    → 401
 *   • seq not > last accepted    → 409 (sequence replay prevention)
 *   • Wrong HMAC signature       → 401 (constant-time comparison)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const faults  = require('../simulator/faults');

const router = express.Router();

router.post('/:deviceId', (req, res) => {
  const deviceId  = req.params.deviceId;
  const timestamp = req.headers['x-timestamp'] || '';
  const seq       = req.headers['x-seq']       || '';
  const signature = req.headers['x-signature'] || '';

  const body = req.body || {};
  if (!body.values || typeof body.values !== 'object') {
    return res.status(400).json({
      error: 'Request body must contain a "values" object',
    });
  }

  // Validate all security constraints
  const { ok, error, status } = engine.validatePush(
    deviceId, timestamp, parseInt(seq, 10), signature, body.values
  );

  if (!ok) {
    return res.status(status || 401).json({ error });
  }

  // Build the stored reading
  const device = engine.getDeviceRaw(deviceId);
  const { _meta } = faults.apply(body.values, device.kind, deviceId, Math.random);

  const reading = {
    deviceId,
    kind:      device.kind,
    label:     device.label,
    timestamp: timestamp || new Date().toISOString(),
    seq:       parseInt(seq, 10),
    values:    body.values,
    status:    'online',
    source:    'push',          // mark as externally pushed vs simulated
    _meta,
  };

  engine.storePushedReading(deviceId, reading);

  res.status(201).json({
    accepted:  true,
    deviceId,
    seq:       reading.seq,
    timestamp: reading.timestamp,
  });
});

module.exports = router;
