/**
 * health.js — GET /api/health
 * Always public (no API key required).
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');

const router = express.Router();

router.get('/', (req, res) => {
  const { startedAt, uptimeSeconds } = engine.getUptime();
  const devices = engine.listDevices();

  res.json({
    status:        'ok',
    version:       '1.0.0',
    uptime:        uptimeSeconds,
    startedAt,
    timestamp:     new Date().toISOString(),
    devices: {
      total:  devices.length,
      online: devices.filter(d => d.status === 'online').length,
      fault:  devices.filter(d => d.status === 'fault').length,
    },
  });
});

module.exports = router;
