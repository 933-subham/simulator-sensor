/**
 * webhook.js — POST /api/webhook/test
 * ─────────────────────────────────────────────────────────────
 * Sends a sample fault_started payload to FAULT_WEBHOOK_URL so
 * you can verify your webhook receiver is working correctly.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

router.post('/test', requireApiKey, async (req, res) => {
  const url = process.env.FAULT_WEBHOOK_URL;
  if (!url) {
    return res.status(400).json({
      error: 'FAULT_WEBHOOK_URL is not configured',
      hint:  'Add FAULT_WEBHOOK_URL to your .env file',
    });
  }

  const sampleFault = {
    id:          'flt-test0001',
    deviceIds:   ['dev-bldA-pwr-f1'],
    type:        'overload',
    severity:    0.8,
    status:      'active',
    startedAt:   new Date().toISOString(),
    endsAt:      null,
    clearedAt:   null,
  };

  try {
    await engine.fireFaultWebhook('fault_started', sampleFault);
    res.json({ sent: true, url, payload: { event: 'fault_started', fault: sampleFault } });
  } catch (err) {
    res.status(500).json({ sent: false, error: err.message });
  }
});

module.exports = router;
