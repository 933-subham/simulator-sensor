/**
 * auth.js — Operator Authentication & Scope Resolution Middleware
 * ─────────────────────────────────────────────────────────────
 * Provides dual-layer authentication:
 *  1. Legacy Global API Key (CONFIGURED_KEY from .env)
 *  2. Enterprise Operator Identity (TOAM - Domain & Org Scoped RBAC)
 *
 * Headers recognized:
 *   x-operator-key: <key>
 *   x-operator-id:  <id>
 *   x-api-key:      <key>
 *   x-org-id:       <orgId>
 *   Query:          ?key=<key>&operatorKey=<key>&orgId=<orgId>
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');
const {
  getOperatorByKey,
  getOperatorById,
  getActiveOperator,
  canAccessDomain,
  canAccessOrg,
  canOperate,
} = require('../access/operators');

const CONFIGURED_KEY = process.env.API_KEY || '';

/**
 * Resolves operator identity onto req.operator and req.orgId.
 * Does not block unauthenticated requests; sets defaults.
 */
function resolveOperator(req, _res, next) {
  const token = req.headers['x-operator-key'] ||
                req.headers['x-operator-id'] ||
                req.headers['x-api-key'] ||
                req.query.operatorKey ||
                req.query.operatorId ||
                req.query.key ||
                '';

  let op = null;
  if (token) {
    op = getOperatorByKey(token) || getOperatorById(token);
  }

  // Fallback to active UI operator session
  if (!op) {
    op = getActiveOperator();
  }

  req.operator = op;

  // Determine effective organization
  const requestedOrg = req.headers['x-org-id'] || req.query.orgId || (req.body && req.body.orgId) || null;
  if (requestedOrg) {
    req.orgId = requestedOrg;
  } else if (op && op.orgId && op.orgId !== '*') {
    req.orgId = op.orgId;
  } else {
    // Default to active profile
    try {
      const { getActiveProfile } = require('../drishti/org-profiles');
      req.orgId = getActiveProfile().id;
    } catch {
      req.orgId = 'college_campus';
    }
  }

  next();
}

/**
 * Express middleware that enforces the API key (or valid Operator key).
 * If API_KEY env is empty/unset, passes through.
 */
function requireApiKey(req, res, next) {
  // Always resolve operator first
  resolveOperator(req, res, () => {
    if (!CONFIGURED_KEY) return next();

    const provided = req.headers['x-api-key'] || req.query.key || req.headers['x-operator-key'] || '';

    if (!provided) {
      return res.status(401).json({
        error: 'Missing API key',
        hint:  'Provide x-api-key header or ?key= query parameter',
      });
    }

    // Check operator key match
    const op = getOperatorByKey(provided);
    if (op) {
      req.operator = op;
      return next();
    }

    // Check global API_KEY match
    const a = Buffer.from(provided);
    const b = Buffer.from(CONFIGURED_KEY);
    const valid = a.length === b.length &&
      (() => { try { return crypto.timingSafeEqual(a, b); } catch { return false; } })();

    if (!valid) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    next();
  });
}

/**
 * Enforces that caller has access to a specific operational domain ('power', 'water', 'waste')
 * @param {'power'|'water'|'waste'} domain
 */
function requireDomain(domain) {
  return (req, res, next) => {
    resolveOperator(req, res, () => {
      const op = req.operator;
      if (!op || !canAccessDomain(op, domain)) {
        return res.status(403).json({
          error: 'Access Restricted (Domain Scope Mismatch)',
          message: `Your assigned operator scope (${op ? op.domains.join(', ') : 'none'}) does not grant access to '${domain}' systems.`,
          requiredDomain: domain,
          currentOperator: op ? { id: op.id, name: op.name, domains: op.domains, role: op.role } : null,
        });
      }
      next();
    });
  };
}

/**
 * Enforces that caller has write / operate permission (blocks 'viewer' role)
 */
function requireOperate(req, res, next) {
  resolveOperator(req, res, () => {
    const op = req.operator;
    if (!op || !canOperate(op)) {
      return res.status(403).json({
        error: 'Permission Denied (Read-Only Mode)',
        message: `Operator account '${op?.name || 'Anonymous'}' has read-only privileges and cannot perform control or modification actions.`,
        currentRole: op?.role || 'viewer',
        permissions: op?.permissions || ['read'],
      });
    }
    next();
  });
}

/**
 * Enforces Administrator role
 */
function requireAdmin(req, res, next) {
  resolveOperator(req, res, () => {
    const op = req.operator;
    if (!op || op.role !== 'admin') {
      return res.status(403).json({
        error: 'Administrator Privilege Required',
        message: 'This operation requires Root Administrator authorization.',
        currentRole: op?.role || 'operator',
      });
    }
    next();
  });
}

/**
 * Enforces that caller has access to the target organization
 */
function requireOrgAccess(req, res, next) {
  resolveOperator(req, res, () => {
    const op = req.operator;
    const targetOrg = req.orgId;
    if (!op || !canAccessOrg(op, targetOrg)) {
      return res.status(403).json({
        error: 'Access Restricted (Organization Isolation)',
        message: `Operator account '${op.name}' is assigned to organization '${op.orgId}' and cannot access '${targetOrg}'.`,
        assignedOrg: op.orgId,
        requestedOrg: targetOrg,
      });
    }
    next();
  });
}

module.exports = {
  resolveOperator,
  requireApiKey,
  requireDomain,
  requireOperate,
  requireAdmin,
  requireOrgAccess,
};
