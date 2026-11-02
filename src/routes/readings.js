/**
 * readings.js — Reading query routes
 * ─────────────────────────────────────────────────────────────
 * GET /api/readings/latest   Most recent reading per device
 * GET /api/summary           Aggregated totals + per-kind breakdown
 * GET /api/devices/:id/latest       Single device latest
 * GET /api/devices/:id/history      Single device history
 * ─────────────────────────────────────────────────────────────
 *
 * ?labels=true  — Include meta: { isAnomaly, faultIds, faultTypes }
 *                 Use this when scoring your AI anomaly model.
 *                 OFF by default so the model sees clean data.
 *
 * ?kind=power_meter|water_tank  — Filter by device kind
 * ?labelPrefix=Building A       — Filter by label prefix (case-insensitive)
 */

'use strict';

const express = require('express');
const engine  = require('../simulator/engine');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
router.use(requireApiKey);

// ── Helper: strip or expose _meta ────────────────────────────────────────────

/**
 * Format a reading for the API response.
 * @param {Object}  reading
 * @param {boolean} includeLabels - whether to expose _meta as "meta"
 * @returns {Object}
 */
function formatReading(reading, includeLabels) {
  const { _meta, ...rest } = reading;
  if (includeLabels && _meta) {
    rest.meta = _meta;
  }
  return rest;
}

// ── GET /api/readings/latest ──────────────────────────────────────────────────

router.get('/latest', (req, res) => {
  const includeLabels = req.query.labels === 'true';
  const filter = {
    kind:        req.query.kind || null,
    labelPrefix: req.query.labelPrefix || req.query.label || null,
  };

  const readings = engine.getLatest(filter);
  res.json(readings.map(r => formatReading(r, includeLabels)));
});

// ── GET /api/summary ──────────────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  res.json(engine.getSummary());
});

// ── GET /api/devices/:id/latest ───────────────────────────────────────────────

router.get('/devices/:id/latest', (req, res) => {
  const includeLabels = req.query.labels === 'true';
  const readings = engine.getLatest();
  const found    = readings.find(r => r.deviceId === req.params.id);

  if (!found) {
    // Check if device exists at all
    const device = engine.getDeviceRaw(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    return res.status(204).end(); // device exists but no readings yet
  }

  res.json(formatReading(found, includeLabels));
});

// ── GET /api/devices/:id/history ─────────────────────────────────────────────

router.get('/devices/:id/history', (req, res) => {
  const includeLabels = req.query.labels === 'true';

  // Parse time filter options
  const opts = {};
  if (req.query.minutes) opts.minutes = parseFloat(req.query.minutes);
  if (req.query.from)    opts.from    = req.query.from;
  if (req.query.to)      opts.to      = req.query.to;

  const readings = engine.getHistory(req.params.id, opts);
  if (readings === null) return res.status(404).json({ error: 'Device not found' });

  res.json(readings.map(r => formatReading(r, includeLabels)));
});

module.exports = router;
