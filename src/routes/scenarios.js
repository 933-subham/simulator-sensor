/**
 * scenarios.js — Preset fault scenarios for quick demos
 * ─────────────────────────────────────────────────────────────
 * GET  /api/scenarios            List available scenarios
 * POST /api/scenarios/:name      Inject a preset scenario
 *
 * Scenarios inject one or more faults via label prefixes so they
 * work regardless of which devices exist at runtime.
 *
 * Available scenarios:
 *   night-leak       — Leak on all water_tank devices (3 h duration)
 *   overload         — Overload on Building A power meters
 *   blackout         — Blackout on all power meters (30 s)
 *   pipe-burst       — Burst on Labs water tanks
 *   multi-fault      — Spike + leak + noisy simultaneously
 *   rogue-sensor     — spoofed_sensor attack on Academic Block devices
 *   replay-attack    — replay_attack on Library devices
 *   data-tampering   — value_injection + drift on Labs power meters
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
    description: 'Simulates a slow pipe leak on all water tanks (3-hour duration)',
    faults: [
      { target: 'all', kind: 'water_tank', type: 'leak', severity: 0.6, durationSec: 10800, rampSec: 60 },
    ],
  },

  'overload': {
    description: 'Electrical overload on Building A power meters',
    faults: [
      { labelPrefix: 'Building A', kind: 'power_meter', type: 'overload', severity: 0.85, rampSec: 30 },
    ],
  },

  'blackout': {
    description: 'Sudden power outage affecting all power meters (30 seconds)',
    faults: [
      { target: 'all', kind: 'power_meter', type: 'blackout', severity: 1.0, durationSec: 30 },
    ],
  },

  'pipe-burst': {
    description: 'Catastrophic pipe burst in Labs water supply',
    faults: [
      { labelPrefix: 'Labs', kind: 'water_tank', type: 'burst', severity: 0.9 },
    ],
  },

  'multi-fault': {
    description: 'Multiple simultaneous faults across the campus',
    faults: [
      { labelPrefix: 'Building A', kind: 'power_meter', type: 'spike',   severity: 0.8, durationSec: 60 },
      { target: 'all',            kind: 'water_tank',  type: 'leak',    severity: 0.5, durationSec: 300 },
      { labelPrefix: 'Library',                        type: 'noisy',   severity: 0.7 },
    ],
  },

  'rogue-sensor': {
    description: 'ATTACK: Spoofed/rogue sensor injecting readings under a fake device ID',
    faults: [
      { labelPrefix: 'Academic Block', type: 'spoofed_sensor', severity: 0.9 },
    ],
  },

  'replay-attack': {
    description: 'ATTACK: Old readings replayed with current timestamps for Library devices',
    faults: [
      { labelPrefix: 'Library', type: 'replay_attack', severity: 1.0 },
    ],
  },

  'data-tampering': {
    description: 'ATTACK: Systematic value injection (reporting lower usage) + drift on Labs power',
    faults: [
      { labelPrefix: 'Labs', kind: 'power_meter', type: 'value_injection', severity: 0.75, rampSec: 120 },
      { labelPrefix: 'Labs', kind: 'power_meter', type: 'drift',           severity: 0.4,  rampSec: 180 },
    ],
  },

  'pump-overflow': {
    description: 'HACKATHON DEMO: Water pump left ON, tank fills up rapidly with live ETA countdown to overflow',
    customAction: 'pump-overflow',
    faults: [],
  },

  'rapid-drain': {
    description: 'HACKATHON DEMO: AI Temporal Anomaly — Tank was full 2 hours ago, suddenly crashed to 11% (hidden burst leak)',
    customAction: 'rapid-drain',
    faults: [],
  },

  'weak-pump': {
    description: 'HACKATHON DEMO: Low voltage / cavitation — pump runs at only 40% pressure and rate, triggering Pump Power Degradation alert',
    customAction: 'weak-pump',
    faults: [],
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

  // Custom Hackathon Predictive AI actions
  if (scenario.customAction === 'pump-overflow') {
    const waterDevices = allDevices.filter(d => d.kind === 'water_tank');
    for (const d of waterDevices) {
      const raw = engine.getDeviceRaw(d.deviceId);
      if (raw) {
        raw.tankLevel = 88; // 88% so countdown to overflow is ~2-3 minutes
        raw.pumpMode = 'manual_on';
        raw.pumpActive = true;
      }
    }
    return res.status(201).json({
      scenario: 'pump-overflow',
      injected: waterDevices.length,
      message: 'Water pump switched ON on all tanks at 88% level — ETA countdown to overflow active!',
    });
  }

  if (scenario.customAction === 'rapid-drain') {
    const waterDevices = allDevices.filter(d => d.kind === 'water_tank');
    for (const d of waterDevices) {
      engine.simulateRapidDrain(d.deviceId, 11);
    }
    return res.status(201).json({
      scenario: 'rapid-drain',
      injected: waterDevices.length,
      message: 'Tank level crashed to 11% while 2-hour historical level is 95% — AI Temporal Anomaly triggered!',
    });
  }

  if (scenario.customAction === 'weak-pump') {
    const waterDevices = allDevices.filter(d => d.kind === 'water_tank');
    for (const d of waterDevices) {
      engine.setPumpState(d.deviceId, 'on', { power: 'weak' });
    }
    return res.status(201).json({
      scenario: 'weak-pump',
      injected: waterDevices.length,
      message: 'Submersible pump running under low pressure (22 LPM / 45% power) — AI Power Degradation Flag active!',
    });
  }

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
