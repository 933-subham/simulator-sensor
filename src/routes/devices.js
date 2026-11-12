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
const { requireApiKey, resolveOperator, requireOperate, requireDomain } = require('../middleware/auth');
const { getDomainForKind, canAccessDomain } = require('../access/operators');

const router = express.Router();

// All device-management endpoints require the API key and operator context
router.use(requireApiKey);
router.use(resolveOperator);

// ── POST /api/devices ────────────────────────────────────────────────────────

/**
 * Create one or more new devices.
 *
 * Request body:
 * {
 *   "kind":          "power_meter" | "water_tank" | "waste_bin" | "waste_compactor",
 *   "label":         "Building A - Floor 2",
 *   "buildingType":  "hostel" | "academic" | "labs" | "library",
 *   "count":         3
 * }
 */
router.post('/', requireOperate, (req, res) => {
  const { kind, label, buildingType, count, capacityLitres, wasteType } = req.body || {};

  const VALID_KINDS  = ['power_meter', 'water_tank', 'waste_bin', 'waste_compactor'];
  const VALID_BUILDS = ['hostel', 'academic', 'labs', 'library'];

  if (!kind || !VALID_KINDS.includes(kind)) {
    return res.status(400).json({
      error: `"kind" is required and must be one of: ${VALID_KINDS.join(', ')}`,
    });
  }

  // Domain permission check
  const targetDomain = getDomainForKind(kind);
  if (req.operator && !canAccessDomain(req.operator, targetDomain)) {
    return res.status(403).json({
      error: 'Access Restricted (Domain Scope Mismatch)',
      message: `Your assigned operator scope (${req.operator.domains.join(', ')}) does not permit registering devices in the '${targetDomain}' domain.`,
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
      capacityLitres: capacityLitres || (kind.startsWith('waste') ? 500 : undefined),
      wasteType: wasteType || (kind.startsWith('waste') ? 'organic_and_solid' : undefined),
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
 * Domain-scoped operators only see devices within their assigned domains.
 */
router.get('/', (req, res) => {
  let list = engine.listDevices();
  const op = req.operator;
  if (op && op.role !== 'admin' && !op.domains.includes('*')) {
    list = list.filter(d => op.domains.includes(getDomainForKind(d.kind)));
  }
  res.json(list);
});

// ── PATCH /api/devices/:id ───────────────────────────────────────────────────

/** Update a device's label. */
router.patch('/:id', requireOperate, (req, res) => {
  const device = engine.getDeviceRaw(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const targetDomain = getDomainForKind(device.kind);
  if (req.operator && !canAccessDomain(req.operator, targetDomain)) {
    return res.status(403).json({
      error: 'Access Restricted (Domain Scope Mismatch)',
      message: `Operator scope does not permit updating devices in '${targetDomain}'.`,
    });
  }

  const { label } = req.body || {};
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: '"label" string is required' });
  }

  device.label = label.trim().slice(0, 120);
  res.json({ deviceId: device.deviceId, label: device.label });
});

// ── POST /api/devices/:id/pump ───────────────────────────────────────────────

/** Control water pump state (on, off, auto) with optional power/inflow rate simulation. */
router.post('/:id/pump', requireOperate, requireDomain('water'), (req, res) => {
  const { action, power, inflowLpm } = req.body || {};
  if (!action) {
    return res.status(400).json({ error: '"action" is required ("on", "off", "auto")' });
  }

  try {
    const result = engine.setPumpState(req.params.id, action.toLowerCase(), { power, inflowLpm });
    if (!result) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true, pump: action.toLowerCase(), details: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/devices/:id/compact ───────────────────────────────────────────

/** Trigger hydraulic compactor cycle on a smart waste station. */
router.post('/:id/compact', requireOperate, requireDomain('waste'), (req, res) => {
  try {
    const result = engine.cycleCompactor(req.params.id);
    if (!result) return res.status(404).json({ error: 'Device not found or not a waste station' });
    res.json({ success: true, action: 'compact', details: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/devices/:id/empty ─────────────────────────────────────────────

/** Empty a waste bin / compactor (simulates sanitation pickup). */
router.post('/:id/empty', requireOperate, requireDomain('waste'), (req, res) => {
  try {
    const result = engine.emptyWasteBin(req.params.id);
    if (!result) return res.status(404).json({ error: 'Device not found or not a waste station' });
    res.json({ success: true, action: 'empty', details: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET & POST /api/devices/:id/predict-fill ─────────────────────────────────

/**
 * Predict time required to fill or drain between two arbitrary levels (fromLevel -> toLevel)
 * based on the tank's trained hydraulic model and current observed ultrasonic fill velocity.
 */
router.all('/:id/predict-fill', (req, res) => {
  const fromLevel = req.query.from !== undefined ? parseFloat(req.query.from) : (req.body?.fromLevel !== undefined ? parseFloat(req.body.fromLevel) : undefined);
  const toLevel   = req.query.to !== undefined   ? parseFloat(req.query.to)   : (req.body?.toLevel !== undefined   ? parseFloat(req.body.toLevel)   : undefined);
  const customRate = req.query.rate !== undefined ? parseFloat(req.query.rate) : (req.body?.customRatePctMin !== undefined ? parseFloat(req.body.customRatePctMin) : undefined);

  try {
    const prediction = engine.predictLevelTransition(req.params.id, {
      fromLevel,
      toLevel,
      customRatePctMin: customRate,
    });
    if (!prediction) return res.status(404).json({ error: 'Device not found or not a water tank' });
    res.json(prediction);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/devices/:id/drain ──────────────────────────────────────────────

/** Simulate sudden rapid drain to demonstrate AI Temporal Memory Leak Anomaly. */
router.post('/:id/drain', (req, res) => {
  const { targetLevel } = req.body || {};
  try {
    const result = engine.simulateRapidDrain(req.params.id, targetLevel !== undefined ? parseFloat(targetLevel) : 12);
    if (!result) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /api/devices/:id ──────────────────────────────────────────────────

/** Remove a device and all its history. */
router.delete('/:id', requireOperate, (req, res) => {
  const removed = engine.removeDevice(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Device not found' });
  res.json({ removed: req.params.id });
});

module.exports = router;
