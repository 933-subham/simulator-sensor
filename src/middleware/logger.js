/**
 * logger.js — Request logging middleware
 * ─────────────────────────────────────────────────────────────
 * Prints one line per request:
 *   [2026-11-02T14:00:00.000Z] POST /api/faults 200 12ms
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const ms     = Date.now() - start;
    const ts     = new Date().toISOString();
    const method = req.method.padEnd(6);
    const url    = req.originalUrl;
    const code   = res.statusCode;
    const color  = code >= 500 ? '\x1b[31m'  // red
                 : code >= 400 ? '\x1b[33m'  // yellow
                 : code >= 300 ? '\x1b[36m'  // cyan
                 :               '\x1b[32m'; // green
    const reset  = '\x1b[0m';
    console.log(`${ts} ${method} ${url} ${color}${code}${reset} ${ms}ms`);
  });

  next();
}

module.exports = { requestLogger };
