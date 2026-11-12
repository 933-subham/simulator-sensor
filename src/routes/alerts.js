/**
 * src/routes/alerts.js
 * ─────────────────────────────────────────────────────────────
 * REST Routes for Enterprise IoT Alert Management.
 *
 * GET  /api/alerts                 List active & historical alerts
 * GET  /api/alerts/summary         Summary counts, severity triage & health
 * GET  /api/alerts/rules           Active threshold rules for current profile
 * PUT  /api/alerts/rules           Customize threshold rules at runtime
 * GET  /api/alerts/channels        Get notification channel config
 * POST /api/alerts/channels        Update notification channels
 * POST /api/alerts/test            Trigger end-to-end simulated alert
 * GET  /api/alerts/:id             Get single alert details
 * POST /api/alerts/:id/acknowledge Acknowledge alert with operator note
 * POST /api/alerts/:id/resolve     Resolve alert manually
 * POST /api/alerts/:id/silence     Snooze / silence alert for N minutes
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const { requireApiKey, resolveOperator, requireOperate } = require('../middleware/auth');
const alertEngine = require('../alerts/engine');
const { getDomainForKind } = require('../access/operators');

const router = express.Router();
router.use(requireApiKey);
router.use(resolveOperator);

// ── GET /api/alerts ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const filter = {
    status: req.query.status || null,
    severity: req.query.severity || null,
    deviceId: req.query.deviceId || null,
    limit: req.query.limit || null,
  };
  let list = alertEngine.getAlerts(filter);
  const op = req.operator;
  if (op && op.role !== 'admin' && !op.domains.includes('*')) {
    list = list.filter(a => op.domains.includes(getDomainForKind(a.kind)));
  }

  res.json({
    total: list.length,
    alerts: list,
  });
});

// ── GET /api/alerts/summary ──────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  res.json(alertEngine.getSummary());
});

// ── GET /api/alerts/rules ────────────────────────────────────────────────────
router.get('/rules', (req, res) => {
  res.json(alertEngine.getActiveRules());
});

// ── PUT /api/alerts/rules ────────────────────────────────────────────────────
router.put('/rules', (req, res) => {
  const updated = alertEngine.updateRules(req.body || {});
  res.json({
    success: true,
    message: 'Alert threshold rules updated.',
    rules: updated,
  });
});

// ── GET /api/alerts/channels ─────────────────────────────────────────────────
router.get('/channels', (req, res) => {
  res.json(alertEngine.getChannelConfig());
});

// ── POST /api/alerts/channels ────────────────────────────────────────────────
router.post('/channels', (req, res) => {
  const updated = alertEngine.setChannelConfig(req.body || {});
  res.json({
    success: true,
    message: 'Alert notification channels updated.',
    channels: updated,
  });
});

// ── GET /api/alerts/emails ──────────────────────────────────────────────────
router.get('/emails', (req, res) => {
  res.json({
    total: alertEngine.getEmailLogs().length,
    emails: alertEngine.getEmailLogs(),
  });
});

// ── GET /api/alerts/breaches ────────────────────────────────────────────────
router.get('/breaches', (req, res) => {
  const breaches = alertEngine.getActiveBreaches();
  res.json({
    total: breaches.length,
    breaches,
  });
});

// ── POST /api/alerts/dispatch-email ──────────────────────────────────────────
router.post('/dispatch-email', async (req, res) => {
  try {
    const result = await alertEngine.flushAlertBatchEmail();
    res.json({
      success: true,
      message: result ? 'Batch email dispatched.' : 'No pending alerts to dispatch.',
      result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/alerts/test ────────────────────────────────────────────────────
router.post('/test', (req, res) => {
  const { severity, title } = req.body || {};
  const testAlert = alertEngine.triggerTestAlert({ severity, title });
  res.status(201).json({
    success: true,
    message: 'End-to-end test alert triggered successfully across all channels.',
    alert: testAlert,
  });
});

// ── GET /api/alerts/:id ──────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const alert = alertEngine.getAlertById(req.params.id);
  if (!alert) {
    return res.status(404).json({ error: `Alert '${req.params.id}' not found.` });
  }
  res.json(alert);
});

// ── POST /api/alerts/:id/acknowledge ─────────────────────────────────────────
router.post('/:id/acknowledge', requireOperate, (req, res) => {
  const { user, note } = req.body || {};
  const operatorName = req.operator?.name || user || 'Facility Operator';
  const updated = alertEngine.acknowledgeAlert(req.params.id, { user: operatorName, note });
  if (!updated) {
    return res.status(404).json({ error: `Alert '${req.params.id}' not found.` });
  }
  res.json({
    success: true,
    message: `Alert '${req.params.id}' acknowledged.`,
    alert: updated,
  });
});

// ── POST /api/alerts/:id/resolve ─────────────────────────────────────────────
router.post('/:id/resolve', requireOperate, (req, res) => {
  const { user, reason } = req.body || {};
  const operatorName = req.operator?.name || user || 'Facility Operator';
  const updated = alertEngine.resolveAlert(req.params.id, { user: operatorName, reason });
  if (!updated) {
    return res.status(404).json({ error: `Alert '${req.params.id}' not found.` });
  }
  res.json({
    success: true,
    message: `Alert '${req.params.id}' resolved.`,
    alert: updated,
  });
});

// ── POST /api/alerts/:id/silence ─────────────────────────────────────────────
router.post('/:id/silence', requireOperate, (req, res) => {
  const duration = parseInt(req.body?.durationMinutes || 30, 10);
  const updated = alertEngine.silenceAlert(req.params.id, duration);
  if (!updated) {
    return res.status(404).json({ error: `Alert '${req.params.id}' not found.` });
  }
  res.json({
    success: true,
    message: `Alert '${req.params.id}' silenced for ${duration} minutes.`,
    alert: updated,
  });
});

module.exports = router;
