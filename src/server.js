/**
 * server.js — Application entry point
 * ─────────────────────────────────────────────────────────────
 * Sets up Express, mounts all routes, and starts the simulation
 * engine before the server begins accepting connections.
 *
 * Run with:
 *   npm start       (production)
 *   npm run dev     (development with nodemon auto-reload)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// Load environment variables from .env file (must be first)
require('dotenv').config();

const path    = require('path');
const express = require('express');
const cors    = require('cors');

const { requestLogger } = require('./middleware/logger');
const engine            = require('./simulator/engine');

// ── Route modules ─────────────────────────────────────────────────────────────
const healthRoute    = require('./routes/health');
const devicesRoute   = require('./routes/devices');
const claimRoute     = require('./routes/claim');
const readingsRoute  = require('./routes/readings');
const pushRoute      = require('./routes/push');
const streamRoute    = require('./routes/stream');
const faultsRoute    = require('./routes/faults');
const scenariosRoute = require('./routes/scenarios');
const webhookRoute   = require('./routes/webhook');
const drishtiRoute   = require('./routes/drishti');
const alertsRoute    = require('./routes/alerts');
const accessRoute    = require('./routes/access');
const storageRoute   = require('./routes/storage');

// ── App setup ─────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow the origins listed in CORS_ORIGIN (comma-separated), or * for all
const rawOrigin = process.env.CORS_ORIGIN || '*';
const corsOrigin = rawOrigin === '*'
  ? '*'
  : rawOrigin.split(',').map(o => o.trim());

app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'x-device-id',
    'x-timestamp',
    'x-seq',
    'x-signature',
    'x-operator-key',
    'x-operator-id',
    'x-org-id',
  ],
}));

// ── Core middleware ───────────────────────────────────────────────────────────

app.use(requestLogger);

// Parse JSON bodies (max 100 KB — keeps payloads reasonable)
app.use(express.json({ limit: '100kb' }));

// Serve the control panel as static HTML at /control (with no-cache so browsers always get fresh UI)
app.use('/control', express.static(path.join(__dirname, '..', 'public', 'control'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ── API routes ────────────────────────────────────────────────────────────────
// All API endpoints live under /api

app.use('/api/health',    healthRoute);
app.use('/api/devices',   devicesRoute);
app.use('/api/claim',     claimRoute);
app.use('/api/readings',  readingsRoute);

// Per-device latest + history (mounted on /api to match /api/devices/:id/...)
app.use('/api',           readingsRoute);

app.use('/api/push',      pushRoute);
app.use('/api/stream',    streamRoute);
app.use('/api/faults',    faultsRoute);
app.use('/api/simulate',  faultsRoute);   // simulate/event + simulate/reset aliases
app.use('/api/scenarios', scenariosRoute);
app.use('/api/webhook',   webhookRoute);
app.use('/api/drishti',   drishtiRoute); // Drishti: Executive Facility & Trend Intelligence
app.use('/api/alerts',    alertsRoute);
app.use('/api/access',    accessRoute);  // Enterprise Operator Identity & RBAC (TOAM)
app.use('/api/storage',   storageRoute); // Secure Cloudinary Storage

// ── Summary shortcut ─────────────────────────────────────────────────────────
app.get('/api/summary', require('./middleware/auth').requireApiKey, (req, res) => {
  res.json(engine.getSummary());
});

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/control'));

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    hint:  'See GET /api/health for available endpoints',
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    error:   err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

let server;

function startServer(port = PORT) {
  engine.start();
  server = app.listen(port, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║       sensor-sim-api  v1.0.0             ║');
    console.log(`  ║       http://localhost:${port}               ║`);
    console.log(`  ║       Control panel: /control            ║`);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  API_KEY:        ${process.env.API_KEY ? '*** (set)' : 'not set (open access)'}`);
    console.log(`  TICK_INTERVAL:  ${process.env.TICK_INTERVAL_MS || 2000} ms`);
    console.log(`  RANDOM_FAULTS:  ${process.env.RANDOM_FAULTS || 'false'}`);
    console.log(`  PUSH_ENABLED:   ${process.env.PUSH_ENABLED || 'false'}`);
    console.log('');
  });
  return server;
}

if (require.main === module) {
  startServer();
}

// Graceful shutdown (e.g. Ctrl+C or Render deploy signal)
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down gracefully');
  engine.stop();
  if (server) server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[server] SIGINT received — shutting down');
  engine.stop();
  if (server) server.close();
  process.exit(0);
});

module.exports = { app, engine, startServer };
