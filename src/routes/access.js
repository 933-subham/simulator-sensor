/**
 * access.js — Operator Identity & Access Management Routes (TOAM)
 * ─────────────────────────────────────────────────────────────
 * GET    /api/access/me              Current authenticated operator context
 * GET    /api/access/operators       List all registered operators
 * POST   /api/access/operators       Provision a new operator identity (Admin only)
 * PATCH  /api/access/operators/:id   Update operator scope/role/org (Admin only)
 * DELETE /api/access/operators/:id   Deprovision operator (Admin only)
 * POST   /api/access/switch          Switch interactive session operator (Demo console)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const {
  listOperators,
  getOperatorById,
  createOperator,
  updateOperator,
  deleteOperator,
  setActiveOperator,
  getActiveOperator,
} = require('../access/operators');
const { resolveOperator, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Always resolve operator on access routes
router.use(resolveOperator);

// ── GET /api/access/me ───────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const op = req.operator || getActiveOperator();
  res.json({
    authenticated: true,
    operator: {
      id: op.id,
      name: op.name,
      username: op.username,
      role: op.role,
      domains: op.domains,
      permissions: op.permissions,
      orgId: op.orgId,
      badge: op.badge,
      description: op.description,
    },
    effectiveOrgId: req.orgId,
  });
});

// ── GET /api/access/operators ────────────────────────────────────────────────
router.get('/operators', (req, res) => {
  const isAdmin = req.operator && req.operator.role === 'admin';
  const ops = listOperators(isAdmin);
  res.json({
    total: ops.length,
    activeOperatorId: getActiveOperator().id,
    operators: ops,
  });
});

// ── POST /api/access/operators (Admin only) ──────────────────────────────────
router.post('/operators', requireAdmin, (req, res) => {
  try {
    const created = createOperator(req.body || {});
    res.status(201).json({
      success: true,
      message: `Operator '${created.name}' provisioned successfully.`,
      operator: created,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── PATCH /api/access/operators/:id (Admin only) ─────────────────────────────
router.patch('/operators/:id', requireAdmin, (req, res) => {
  try {
    const updated = updateOperator(req.params.id, req.body || {});
    res.json({
      success: true,
      message: `Operator '${updated.name}' updated.`,
      operator: updated,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /api/access/operators/:id (Admin only) ────────────────────────────
router.delete('/operators/:id', requireAdmin, (req, res) => {
  try {
    deleteOperator(req.params.id);
    res.json({
      success: true,
      message: `Operator '${req.params.id}' deleted.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/access/switch ──────────────────────────────────────────────────
// Convenient endpoint for Web Control Panel to switch active simulated identity
router.post('/switch', (req, res) => {
  const { operatorId } = req.body || {};
  if (!operatorId) {
    return res.status(400).json({ error: 'Missing operatorId in request body.' });
  }

  try {
    const op = setActiveOperator(operatorId);
    res.json({
      success: true,
      message: `Active session switched to '${op.name}' (${op.badge})`,
      operator: {
        id: op.id,
        name: op.name,
        username: op.username,
        role: op.role,
        domains: op.domains,
        permissions: op.permissions,
        orgId: op.orgId,
        badge: op.badge,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
