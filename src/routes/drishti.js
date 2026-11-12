/**
 * drishti.js — Drishti: Executive Facility & Trend Intelligence Routes
 * ─────────────────────────────────────────────────────────────
 * GET  /api/drishti/synthesis       Executive plain-language synthesis & analytics
 * POST /api/drishti/chat            Interactive multi-turn Drishti chat
 * GET  /api/drishti/diagnose/:id    Targeted device diagnostic with ₹ impact
 * GET  /api/drishti/profiles        List all organization profiles
 * POST /api/drishti/profile         Switch active organization profile
 * GET  /api/drishti/config          Drishti engine status & model info
 * POST /api/drishti/config          Update API key or model at runtime
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const synthesizer = require('../drishti/synthesizer');
const { listProfiles, setActiveProfile, getActiveProfile } = require('../drishti/org-profiles');

const router = express.Router();

// Authentication via API key middleware
router.use(requireApiKey);

// ── GET /api/drishti/synthesis ───────────────────────────────────────────────
router.get('/synthesis', async (req, res, next) => {
  try {
    const result = await synthesizer.getSynthesis({
      operator: req.operator,
      orgId: req.query.orgId || req.orgId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/drishti/chat ───────────────────────────────────────────────────
router.post('/chat', async (req, res, next) => {
  try {
    const { query, message, orgId } = req.body || {};
    const userQuery = query || message;

    if (!userQuery || typeof userQuery !== 'string' || !userQuery.trim()) {
      return res.status(400).json({ error: 'Query is required in request body: { query: "..." }' });
    }

    const effectiveOrgId = orgId || req.headers['x-org-id'] || req.query.orgId || req.orgId;
    const { canAccessOrg } = require('../access/operators');
    if (req.operator && !canAccessOrg(req.operator, effectiveOrgId)) {
      return res.status(403).json({
        error: 'Access Restricted (Organization Isolation)',
        message: `Operator account '${req.operator.name}' belongs to organization '${req.operator.orgId}' and cannot query intelligence for '${effectiveOrgId}'.`,
        assignedOrg: req.operator.orgId,
        requestedOrg: effectiveOrgId,
      });
    }

    const result = await synthesizer.chat(userQuery.trim(), {
      operator: req.operator,
      orgId: effectiveOrgId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/drishti/diagnose/:deviceId ──────────────────────────────────────
router.get('/diagnose/:deviceId', (req, res) => {
  try {
    const diagnosis = synthesizer.diagnoseDevice(req.params.deviceId, {
      operator: req.operator,
      orgId: req.query.orgId || req.orgId,
    });
    if (!diagnosis) {
      return res.status(404).json({ error: `Device '${req.params.deviceId}' not found.` });
    }
    res.json(diagnosis);
  } catch (err) {
    if (err.status === 403 || err.message?.includes('Access Restricted')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/drishti/profiles ────────────────────────────────────────────────
router.get('/profiles', (req, res) => {
  res.json({
    active: getActiveProfile(),
    profiles: listProfiles(),
  });
});

// ── POST /api/drishti/profile ────────────────────────────────────────────────
router.post('/profile', (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId) {
    return res.status(400).json({ error: 'Missing profileId in request body.' });
  }

  try {
    const newProfile = setActiveProfile(profileId);
    res.json({
      success: true,
      activeProfile: newProfile,
      message: `Active organization profile switched to '${newProfile.name}'.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/drishti/config ──────────────────────────────────────────────────
router.get('/config', (req, res) => {
  res.json(synthesizer.getConfig());
});

// ── POST /api/drishti/config ─────────────────────────────────────────────────
router.post('/config', (req, res) => {
  const { apiKey, model } = req.body || {};
  synthesizer.setConfig({ apiKey, model });
  res.json({
    success: true,
    config: synthesizer.getConfig(),
  });
});

module.exports = router;
