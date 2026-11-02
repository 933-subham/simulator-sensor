/**
 * claim.js — POST /api/claim
 * ─────────────────────────────────────────────────────────────
 * The main website calls this endpoint after the administrator
 * creates a device and shares the claimCode out-of-band.
 *
 * The secret is returned EXACTLY ONCE and then the claim code
 * is permanently marked used. Calling again returns 410 Gone.
 *
 * This endpoint requires the global API key (the main website
 * holds this key, not end-user browsers).
 *
 * Request:
 *   POST /api/claim
 *   { "claimCode": "CLAIM-AB12-CD34" }
 *
 * Response (first call):
 *   201 { deviceId, kind, label, secret }
 *
 * Response (code already used):
 *   410 { error: "Claim code already used or not found" }
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireApiKey, (req, res) => {
  const { claimCode } = req.body || {};

  if (!claimCode || typeof claimCode !== 'string') {
    return res.status(400).json({ error: '"claimCode" string is required' });
  }

  const result = engine.claimDevice(claimCode.trim().toUpperCase());

  if (!result) {
    return res.status(410).json({
      error: 'Claim code already used or not found',
      hint:  'Each claim code can only be used once. Create a new device to get a new code.',
    });
  }

  // Secret is shown here and only here
  res.status(201).json({
    deviceId: result.deviceId,
    kind:     result.kind,
    label:    result.label,
    secret:   result.secret,
    note:     'Save this secret — it will not be shown again.',
  });
});

module.exports = router;
