/**
 * operators.js
 * ─────────────────────────────────────────────────────────────
 * Enterprise Access & Operator Identity Framework (TOAM)
 * Multi-Tenant, Domain-Scoped Identity & Permission Management.
 *
 * Provides granular access control inspired by cloud operator
 * delegation architectures, without IAM-specific branding:
 *
 * Roles & Hierarchy:
 *  1. Root Administrator (Platform Superuser)
 *     - Global scope across all organizations (orgId: '*')
 *     - Full read, operate, configure, and operator management ('*')
 *  2. Domain Specialists (Operational Leads)
 *     - Scoped to specific operational domain:
 *         • 'power'  -> Electrical meters, transformers, DISCOM tariffs
 *         • 'water'  -> Tanks, ultrasonic levels, pumps, hydraulic flow
 *         • 'waste'  -> Smart bins, compactors, odor/methane, collection
 *  3. Privilege Levels:
 *     - 'viewer'  : Read-only observation of telemetry, charts, and Drishti
 *     - 'operator': Read + write (fault injection, pump control, compactor cycling)
 *     - 'admin'   : Full operator administration + organizational reconfiguration
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

/**
 * Seed Operator Directory
 * Map<string, Object> indexed by operator id
 */
const operators = new Map();

/** Current active operator session for the interactive web console */
let activeOperatorId = 'op-root';

/**
 * Initialize seed operators
 */
function initSeedOperators() {
  const seeds = [
    {
      id: 'op-root',
      name: 'Estate & Facility Director',
      username: 'root.admin',
      key: 'op-root-key',
      role: 'admin',
      domains: ['*'],
      permissions: ['*'],
      orgId: '*',
      badge: '👑 Root Administrator',
      description: 'Platform superuser with unrestricted cross-organization and cross-domain control.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'op-power',
      name: 'Chief Electrical Engineer',
      username: 'power.lead',
      key: 'op-power-key',
      role: 'operator',
      domains: ['power'],
      permissions: ['read', 'operate'],
      orgId: 'college_campus',
      badge: '⚡ Power Specialist',
      description: 'Substations, LT panels, transformers, demand surcharges, and power factor correction.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'op-water',
      name: 'Hydraulics & Water Superintendent',
      username: 'water.lead',
      key: 'op-water-key',
      role: 'operator',
      domains: ['water'],
      permissions: ['read', 'operate'],
      orgId: 'college_campus',
      badge: '💧 Water Utility Specialist',
      description: 'Reservoirs, OHT tanks, pumps, ultrasonic virtual sensing, and pipe rupture containment.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'op-waste',
      name: 'Sanitation & Waste Operations Lead',
      username: 'waste.lead',
      key: 'op-waste-key',
      role: 'operator',
      domains: ['waste'],
      permissions: ['read', 'operate'],
      orgId: 'college_campus',
      badge: '♻️ Waste Management Specialist',
      description: 'Solid waste compactors, organic waste stations, fill levels, odor/methane safety, and collection.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'op-power-viewer',
      name: 'Energy Audit Analyst (Read-Only)',
      username: 'power.auditor',
      key: 'op-power-view-key',
      role: 'viewer',
      domains: ['power'],
      permissions: ['read'],
      orgId: 'college_campus',
      badge: '👁️ Power Auditor (Viewer)',
      description: 'Read-only observer for DISCOM tariff compliance and energy audits without control access.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'op-facility-lead',
      name: 'Assistant Facility Manager',
      username: 'facility.lead',
      key: 'op-facility-key',
      role: 'operator',
      domains: ['power', 'water', 'waste'],
      permissions: ['read', 'operate'],
      orgId: 'college_campus',
      badge: '🏢 Multi-Domain Facility Lead',
      description: 'Cross-functional operational manager with access across Power, Water, and Waste Management.',
      createdAt: new Date().toISOString(),
    },
  ];

  operators.clear();
  for (const op of seeds) {
    operators.set(op.id, op);
  }
}

// Initial setup
initSeedOperators();

/**
 * List all operators (optionally sanitize secrets for non-admin callers)
 * @param {boolean} [includeKeys=false]
 * @returns {Array<Object>}
 */
function listOperators(includeKeys = false) {
  return Array.from(operators.values()).map(op => {
    const copy = { ...op, isActiveSession: op.id === activeOperatorId };
    if (!includeKeys) {
      delete copy.key;
    }
    return copy;
  });
}

/**
 * Find operator by ID
 * @param {string} id
 * @returns {Object|null}
 */
function getOperatorById(id) {
  return operators.get(id) || null;
}

/**
 * Find operator by secret key or username
 * @param {string} tokenOrKey
 * @returns {Object|null}
 */
function getOperatorByKey(tokenOrKey) {
  if (!tokenOrKey) return null;
  const clean = String(tokenOrKey).trim();
  for (const op of operators.values()) {
    if (op.key === clean || op.username === clean || op.id === clean) {
      return op;
    }
  }
  return null;
}

/**
 * Get active interactive console operator
 * @returns {Object}
 */
function getActiveOperator() {
  return operators.get(activeOperatorId) || operators.get('op-root');
}

/**
 * Set active interactive console operator
 * @param {string} id
 * @returns {Object}
 */
function setActiveOperator(id) {
  const op = operators.get(id);
  if (!op) {
    throw new Error(`Operator '${id}' not found.`);
  }
  activeOperatorId = id;
  return op;
}

/**
 * Create a new operator account (Admin privilege required)
 * @param {Object} data
 * @returns {Object}
 */
function createOperator(data) {
  const { name, username, domains, role = 'operator', permissions, orgId, description } = data;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Operator name is required.');
  }
  if (!username || typeof username !== 'string' || !username.trim()) {
    throw new Error('Username is required.');
  }

  // Check unique username
  for (const op of operators.values()) {
    if (op.username.toLowerCase() === username.toLowerCase().trim()) {
      throw new Error(`Username '${username}' is already in use.`);
    }
  }

  const assignedDomains = Array.isArray(domains) && domains.length > 0 ? domains : ['power'];
  const validDomains = ['power', 'water', 'waste', '*'];
  for (const d of assignedDomains) {
    if (!validDomains.includes(d)) {
      throw new Error(`Invalid domain '${d}'. Allowed: ${validDomains.join(', ')}`);
    }
  }

  const validRoles = ['admin', 'operator', 'viewer'];
  if (!validRoles.includes(role)) {
    throw new Error(`Invalid role '${role}'. Allowed: ${validRoles.join(', ')}`);
  }

  let assignedPerms = permissions;
  if (!Array.isArray(assignedPerms) || assignedPerms.length === 0) {
    if (role === 'admin') assignedPerms = ['*'];
    else if (role === 'viewer') assignedPerms = ['read'];
    else assignedPerms = ['read', 'operate'];
  }

  const id = `op-${crypto.randomBytes(4).toString('hex')}`;
  const key = `op-key-${crypto.randomBytes(8).toString('hex')}`;

  let badge = '👤 Operator';
  if (role === 'admin') badge = '👑 Administrator';
  else if (role === 'viewer') badge = '👁️ Observer';
  else if (assignedDomains.includes('*') || assignedDomains.length > 2) badge = '🏢 Multi-Domain Lead';
  else if (assignedDomains.includes('power')) badge = '⚡ Power Specialist';
  else if (assignedDomains.includes('water')) badge = '💧 Water Specialist';
  else if (assignedDomains.includes('waste')) badge = '♻️ Waste Specialist';

  const newOp = {
    id,
    name: name.trim(),
    username: username.toLowerCase().trim(),
    key,
    role,
    domains: assignedDomains,
    permissions: assignedPerms,
    orgId: orgId || 'college_campus',
    badge,
    description: description || 'Custom assigned operator profile.',
    createdAt: new Date().toISOString(),
  };

  operators.set(id, newOp);
  return newOp;
}

/**
 * Update an existing operator
 * @param {string} id
 * @param {Object} updates
 * @returns {Object}
 */
function updateOperator(id, updates = {}) {
  const op = operators.get(id);
  if (!op) {
    throw new Error(`Operator '${id}' not found.`);
  }

  if (updates.name !== undefined) op.name = String(updates.name).trim();
  if (updates.role !== undefined) {
    const validRoles = ['admin', 'operator', 'viewer'];
    if (!validRoles.includes(updates.role)) {
      throw new Error(`Invalid role '${updates.role}'.`);
    }
    op.role = updates.role;
  }
  if (updates.domains !== undefined) {
    if (!Array.isArray(updates.domains) || updates.domains.length === 0) {
      throw new Error('Domains must be a non-empty array.');
    }
    op.domains = updates.domains;
  }
  if (updates.permissions !== undefined) {
    if (!Array.isArray(updates.permissions) || updates.permissions.length === 0) {
      throw new Error('Permissions must be a non-empty array.');
    }
    op.permissions = updates.permissions;
  }
  if (updates.orgId !== undefined) op.orgId = updates.orgId;
  if (updates.description !== undefined) op.description = updates.description;
  if (updates.badge !== undefined) op.badge = updates.badge;

  return op;
}

/**
 * Delete an operator
 * @param {string} id
 * @returns {boolean}
 */
function deleteOperator(id) {
  if (id === 'op-root') {
    throw new Error('The Root Administrator account cannot be deleted.');
  }
  if (id === activeOperatorId) {
    activeOperatorId = 'op-root';
  }
  return operators.delete(id);
}

/**
 * Check if operator has access to a specific operational domain
 * @param {Object} operator
 * @param {'power'|'water'|'waste'} domain
 * @returns {boolean}
 */
function canAccessDomain(operator, domain) {
  if (!operator) return false;
  if (operator.role === 'admin' || operator.domains.includes('*')) return true;
  return operator.domains.includes(domain);
}

/**
 * Check if operator has access to execute an action in an organization
 * @param {Object} operator
 * @param {string} targetOrgId
 * @returns {boolean}
 */
function canAccessOrg(operator, targetOrgId) {
  if (!operator) return false;
  if (operator.role === 'admin' || operator.orgId === '*') return true;
  return operator.orgId === targetOrgId;
}

/**
 * Check if operator has write/operate privileges
 * @param {Object} operator
 * @returns {boolean}
 */
function canOperate(operator) {
  if (!operator) return false;
  if (operator.role === 'admin') return true;
  if (operator.role === 'viewer') return false;
  return operator.permissions.includes('*') || operator.permissions.includes('operate') || operator.permissions.includes('write');
}

/**
 * Map device kind to operational domain
 * @param {string} kind
 * @returns {'power'|'water'|'waste'|'other'}
 */
function getDomainForKind(kind) {
  if (kind === 'power_meter') return 'power';
  if (kind === 'water_tank') return 'water';
  if (kind === 'waste_bin' || kind === 'waste_compactor') return 'waste';
  return 'other';
}

module.exports = {
  listOperators,
  getOperatorById,
  getOperatorByKey,
  getActiveOperator,
  setActiveOperator,
  createOperator,
  updateOperator,
  deleteOperator,
  canAccessDomain,
  canAccessOrg,
  canOperate,
  getDomainForKind,
  resetSeedOperators: initSeedOperators,
};
