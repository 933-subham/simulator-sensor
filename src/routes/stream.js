/**
 * stream.js — GET /api/stream  (Server-Sent Events)
 * ─────────────────────────────────────────────────────────────
 * Streams the latest readings to the client on every engine tick.
 * Clients receive a continuous stream of JSON events — no polling.
 *
 * Usage (JavaScript):
 *   const es = new EventSource('/api/stream?key=YOUR_API_KEY');
 *   es.addEventListener('reading', e => {
 *     const readings = JSON.parse(e.data);
 *     console.log(readings);
 *   });
 *
 * Query parameters:
 *   ?key=          API key (alternative to x-api-key header, for browsers)
 *   ?kind=         Filter by 'power_meter' or 'water_tank'
 *   ?labelPrefix=  Filter by label prefix
 *   ?labels=true   Include meta: { isAnomaly, faultIds, faultTypes }
 *
 * SSE events sent:
 *   event: connected   — sent once on connection, includes device list
 *   event: reading     — sent every tick, array of latest readings
 *   event: heartbeat   — sent every 30 s to keep connection alive
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const engine      = require('../simulator/engine');
const alertEngine = require('../alerts/engine');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// Heartbeat interval — keeps the connection alive through proxies
const HEARTBEAT_MS = 30_000;

router.get('/', requireApiKey, (req, res) => {
  const includeLabels  = req.query.labels === 'true';
  const kindFilter     = req.query.kind        || null;
  const labelFilter    = req.query.labelPrefix || req.query.label || null;

  // ── SSE setup ──────────────────────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering

  // Helper to write an SSE event
  const send = (eventName, data) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send the device list and current active alerts on connect
  send('connected', {
    message: 'Connected to sensor-sim-api stream',
    devices: engine.listDevices(),
    activeAlerts: alertEngine.getAlerts(),
    alertSummary: alertEngine.getSummary(),
    timestamp: new Date().toISOString(),
  });

  // ── Reading filter helper ──────────────────────────────────────────────────
  function formatReading(r) {
    const { _meta, _baseline, ...rest } = r;
    if (includeLabels && _meta) rest.meta = _meta;
    return rest;
  }

  // ── Tick handler ───────────────────────────────────────────────────────────
  function onTick(batchReadings) {
    let filtered = batchReadings;
    if (kindFilter) {
      filtered = filtered.filter(r => r.kind === kindFilter);
    }
    if (labelFilter) {
      filtered = filtered.filter(r =>
        r.label && r.label.toLowerCase().startsWith(labelFilter.toLowerCase())
      );
    }
    if (filtered.length > 0) {
      send('reading', filtered.map(formatReading));
    }
  }

  // ── Alert event handlers ───────────────────────────────────────────────────
  const onAlertTriggered = (alert) => send('alert_triggered', alert);
  const onAlertUpdated   = (alert) => send('alert_updated', alert);
  const onAlertResolved  = (alert) => send('alert_resolved', alert);
  const onAlertAcked     = (alert) => send('alert_acknowledged', alert);
  const onAlertBatchMail = (data)  => send('alert_batch_email', data);

  engine.emitter.on('tick', onTick);
  alertEngine.emitter.on('alert_triggered', onAlertTriggered);
  alertEngine.emitter.on('alert_updated', onAlertUpdated);
  alertEngine.emitter.on('alert_resolved', onAlertResolved);
  alertEngine.emitter.on('alert_acknowledged', onAlertAcked);
  alertEngine.emitter.on('alert_batch_email', onAlertBatchMail);

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  const heartbeatTimer = setInterval(() => {
    send('heartbeat', { timestamp: new Date().toISOString() });
  }, HEARTBEAT_MS);

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  req.on('close', () => {
    engine.emitter.off('tick', onTick);
    alertEngine.emitter.off('alert_triggered', onAlertTriggered);
    alertEngine.emitter.off('alert_updated', onAlertUpdated);
    alertEngine.emitter.off('alert_resolved', onAlertResolved);
    alertEngine.emitter.off('alert_acknowledged', onAlertAcked);
    alertEngine.emitter.off('alert_batch_email', onAlertBatchMail);

    clearInterval(heartbeatTimer);
  });
});

module.exports = router;
