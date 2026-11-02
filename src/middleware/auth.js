/**
 * auth.js — API key middleware
 * ─────────────────────────────────────────────────────────────
 * If API_KEY is set in .env, every request must include:
 *   Header:       x-api-key: <key>
 *   OR query:     ?key=<key>   (for SSE streams and browser testing)
 *
 * Excluded: GET /api/health (always public)
 *
 * Usage in routes:
 *   const { requireApiKey } = require('../middleware/auth');
 *   router.post('/faults', requireApiKey, handler);
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const CONFIGURED_KEY = process.env.API_KEY || '';

/**
 * Express middleware that enforces the API key.
 * If API_KEY env is empty/unset, this middleware is a no-op (passes through).
 */
function requireApiKey(req, res, next) {
  // No key configured — open access
  if (!CONFIGURED_KEY) return next();

  const provided = req.headers['x-api-key'] || req.query.key || '';

  if (!provided) {
    return res.status(401).json({
      error: 'Missing API key',
      hint:  'Provide x-api-key header or ?key= query parameter',
    });
  }

  // Constant-time comparison to prevent timing attacks
  const crypto = require('crypto');
  const a = Buffer.from(provided);
  const b = Buffer.from(CONFIGURED_KEY);
  const valid = a.length === b.length &&
    (() => { try { return crypto.timingSafeEqual(a, b); } catch { return false; } })();

  if (!valid) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
}

module.exports = { requireApiKey };
