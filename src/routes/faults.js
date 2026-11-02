/**
 * faults.js (route) — Fault injection + management
 * ─────────────────────────────────────────────────────────────
 * POST   /api/faults              Inject a fault
 * POST   /api/simulate/event      Alias for POST /api/faults
 * GET    /api/faults              List active + recently clearing faults
 * GET    /api/faults/types        List all valid fault type names + descriptions
 * GET    /api/faults/log          Full fault history (for AI model comparison)
 * DELETE /api/faults/:id          Clear one fault
 * DELETE /api/faults              Clear all faults
 * POST   /api/simulate/reset      Reset the entire simulation
 *
 * ── Target resolution ──
 * The "target" in POST /api/faults can be:
 *   { deviceId: "dev-bldA-pwr-f1" }             — single device
 *   { deviceIds: ["dev-...", "dev-..."] }        — explicit list
 *   { labelPrefix: "Building A" }               — all matching labels
 *   { kind: "water_tank" }                      — all devices of that kind
 *   { target: "all" }                           — every registered device
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const faults  = require('../simulator/faults');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
router.use(requireApiKey);

// ── Target resolution ─────────────────────────────────────────────────────────

/**
 * Resolve fault target to an array of device IDs.
 * @param {Object} body - Request body
 * @returns {{ ids: string[], error?: string }}
 */
function resolveTargets(body) {
  const all = engine.listDevices();

  if (body.target === 'all') {
    return { ids: all.map(d => d.deviceId) };
  }

  if (body.deviceIds && Array.isArray(body.deviceIds)) {
    const valid   = body.deviceIds.filter(id => engine.getDeviceRaw(id));
    const invalid = body.deviceIds.filter(id => !engine.getDeviceRaw(id));
    if (invalid.length > 0) {
      return { ids: [], error: `Unknown device IDs: ${invalid.join(', ')}` };
    }
    return { ids: valid };
  }

  if (body.deviceId) {
    if (!engine.getDeviceRaw(body.deviceId)) {
      return { ids: [], error: `Unknown device ID: ${body.deviceId}` };
    }
    return { ids: [body.deviceId] };
  }

  if (body.labelPrefix) {
    const prefix  = body.labelPrefix.toLowerCase();
    const matched = all.filter(d => d.label.toLowerCase().startsWith(prefix));
    if (matched.length === 0) {
      return { ids: [], error: `No devices found with label prefix: "${body.labelPrefix}"` };
    }
    return { ids: matched.map(d => d.deviceId) };
  }

  if (body.kind) {
    const matched = all.filter(d => d.kind === body.kind);
    if (matched.length === 0) {
      return { ids: [], error: `No devices found with kind: "${body.kind}"` };
    }
    return { ids: matched.map(d => d.deviceId) };
  }

  return { ids: [], error: 'No target specified. Use deviceId, deviceIds, labelPrefix, kind, or target: "all"' };
}

// ── Inject fault ──────────────────────────────────────────────────────────────

function injectHandler(req, res) {
  const body = req.body || {};

  // Validate fault type
  if (!body.type) {
    return res.status(400).json({ error: '"type" is required' });
  }

  // Validate severity
  const severity = parseFloat(body.severity) || 0.7;
  if (severity < 0.1 || severity > 1.0) {
    return res.status(400).json({ error: '"severity" must be between 0.1 and 1.0' });
  }

  // Resolve targets
  const { ids, error: targetError } = resolveTargets(body);
  if (targetError) return res.status(400).json({ error: targetError });

  try {
    const record = faults.inject({
      deviceIds:   ids,
      type:        body.type,
      severity,
      durationSec: body.durationSec ? parseFloat(body.durationSec) : undefined,
      rampSec:     body.rampSec     ? parseFloat(body.rampSec)     : undefined,
    });

    // Fire webhook (fire-and-forget)
    engine.fireFaultWebhook('fault_started', record).catch(() => {});

    res.status(201).json(record);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

router.post('/',              injectHandler);
router.post('/simulate/event', injectHandler);  // alias

// ── Get active faults ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.json(faults.getActive());
});

// ── Get fault types ───────────────────────────────────────────────────────────

router.get('/types', (req, res) => {
  res.json(faults.listTypes());
});

// ── Get fault log ─────────────────────────────────────────────────────────────

router.get('/log', (req, res) => {
  res.json(faults.getLog());
});

// ── Clear one fault ───────────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const rec = faults.clear(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Fault not found' });

  engine.fireFaultWebhook('fault_cleared', rec).catch(() => {});
  res.json(rec);
});

// ── Clear all faults ──────────────────────────────────────────────────────────

router.delete('/', (req, res) => {
  const cleared = faults.clearAll();
  cleared.forEach(rec => engine.fireFaultWebhook('fault_cleared', rec).catch(() => {}));
  res.json({ cleared: cleared.length, faults: cleared });
});

// ── Reset simulation ──────────────────────────────────────────────────────────

router.post('/simulate/reset', (req, res) => {
  engine.reset();
  res.json({ status: 'reset', timestamp: new Date().toISOString() });
});

module.exports = router;
