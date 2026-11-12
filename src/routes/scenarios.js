/**
 * scenarios.js — Preset fault scenarios for quick demos
 * ─────────────────────────────────────────────────────────────
 * GET  /api/scenarios            List available scenarios
 * POST /api/scenarios/:name      Inject a preset scenario
 *
 * Scenarios inject faults via label prefixes or kinds so they
 * work regardless of which devices exist at runtime.
 *
 * Available scenarios:
 *   night-leak       — Leak on all water_tank devices (3 h duration)
 *   overload         — Overload on Building A power meters
 *   rogue-sensor     — spoofed_sensor attack on Academic Block devices
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const faults  = require('../simulator/faults');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
router.use(requireApiKey);

// ── Scenario definitions ──────────────────────────────────────────────────────

/**
 * Each scenario is an array of fault specifications.
 * target is resolved at injection time against the live device list.
 */
const SCENARIOS = {
  'night-leak': {
    description: 'Simulates a pipe leak on all water tanks (3-hour duration)',
    faults: [
      { target: 'all', kind: 'water_tank', type: 'leak', severity: 0.85, durationSec: 10800, rampSec: 2 },
    ],
  },

  'overload': {
    description: 'Electrical overload on Building A power meters',
    faults: [
      { labelPrefix: 'Building A', kind: 'power_meter', type: 'overload', severity: 0.90, rampSec: 2 },
    ],
  },

  'rogue-sensor': {
    description: 'ATTACK: Spoofed/rogue sensor injecting readings under a fake device ID',
    faults: [
      { labelPrefix: 'Academic Block', type: 'spoofed_sensor', severity: 0.9 },
    ],
  },
};

// ── GET /api/scenarios ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const list = Object.entries(SCENARIOS).map(([name, s]) => ({
    name,
    description: s.description,
    faultCount:  s.faults ? s.faults.length : 1,
  }));
  res.json(list);
});

// ── POST /api/scenarios/:name ─────────────────────────────────────────────────

router.post('/:name', (req, res) => {
  const scenario = SCENARIOS[req.params.name];
  if (!scenario) {
    return res.status(404).json({
      error:     `Unknown scenario: "${req.params.name}"`,
      available: Object.keys(SCENARIOS),
    });
  }

  const allDevices = engine.listDevices();
  const injected   = [];
  const errors     = [];

  for (const spec of scenario.faults) {
    // Resolve target IDs
    let ids = [];

    if (spec.target === 'all') {
      ids = allDevices
        .filter(d => !spec.kind || d.kind === spec.kind)
        .map(d => d.deviceId);
    } else if (spec.labelPrefix) {
      const prefix = spec.labelPrefix.toLowerCase();
      ids = allDevices
        .filter(d => d.label.toLowerCase().startsWith(prefix))
        .filter(d => !spec.kind || d.kind === spec.kind)
        .map(d => d.deviceId);
    }

    if (ids.length === 0) {
      errors.push(`No devices matched for fault type "${spec.type}"`);
      continue;
    }

    try {
      const record = faults.inject({
        deviceIds:   ids,
        type:        spec.type,
        severity:    spec.severity || 0.7,
        durationSec: spec.durationSec,
        rampSec:     spec.rampSec,
      });
      engine.fireFaultWebhook('fault_started', record).catch(() => {});
      injected.push(record);
    } catch (err) {
      errors.push(`${spec.type}: ${err.message}`);
    }
  }

  res.status(201).json({
    scenario:    req.params.name,
    description: scenario.description,
    injected:    injected.length,
    faults:      injected,
    errors:      errors.length > 0 ? errors : undefined,
  });
});

module.exports = router;
