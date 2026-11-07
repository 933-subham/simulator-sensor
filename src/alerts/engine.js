/**
 * src/alerts/engine.js
 * ─────────────────────────────────────────────────────────────
 * End-to-End Enterprise Alert Engine for sensor-sim-api.
 *
 * Designed specifically for Indian infrastructure and regulatory
 * standards (CEA Grid Standards 230V/415V, BIS IS 12360, State
 * DISCOM Power Factor & Time-of-Day Tariffs, CPHEEO Water Supply,
 * and NBC 2016 norms).
 *
 * Multi-Scale Organization Adaptability:
 *  1. Single House / Villa / Residential Society (LT Domestic, RWA)
 *  2. College Campus / University (HT-2B Institutional)
 *  3. Multi-Specialty Hospital / Healthcare (Life-Critical 24/7)
 *  4. Commercial IT Park / Tech Hub (HT Commercial, BMS)
 *  5. Industrial Plant / Big Power House / Substation (HT-1 Heavy Industry)
 *
 * Core Features:
 *  • Real-time rule-based telemetry evaluation on every tick
 *  • Multi-tier triage: CRITICAL (P1), HIGH (P2), MEDIUM (P3), LOW (P4)
 *  • Deduplication & correlation (prevents alert spam)
 *  • Automatic recovery & auto-resolution when metrics normalize
 *  • Complete lifecycle: triggered -> acknowledged -> silenced -> resolved
 *  • Indian Financial Impact calculation (₹/hr leak loss, DISCOM PF penalties)
 *  • Multi-channel notification formatting (TRAI DLT SMS, WhatsApp, Webhook, Email, Audio)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const {
  GRID_STANDARDS,
  DEFAULT_TARIFFS,
  formatINR,
  formatIST,
  calculatePFPenalty,
  getToDSlot,
} = require('../drishti/india-standards');
const { getActiveProfile } = require('../drishti/org-profiles');

// ── Notification Channel Configuration ────────────────────────────────────────

const channelConfig = {
  webhook: {
    enabled: Boolean(process.env.ALERT_WEBHOOK_URL || process.env.FAULT_WEBHOOK_URL),
    url: process.env.ALERT_WEBHOOK_URL || process.env.FAULT_WEBHOOK_URL || '',
    secret: process.env.WEBHOOK_SECRET || '',
  },
  sms_dlt: {
    enabled: true,
    senderId: 'FACIND', // Indian TRAI 6-character Header
    entityId: '110154829000001',
  },
  whatsapp: {
    enabled: true,
    namespace: 'facility_alerts',
  },
  email: {
    enabled: true,
    supportEmail: 'facilities-alert@enterprise.in',
  },
  audio: {
    enabled: true,
  },
};

// ── Organization-Specific Alert Threshold Profiles ────────────────────────────

const PROFILE_THRESHOLDS = {
  residential_society: {
    voltage: { min: 211.0, max: 248.0, unit: 'V' }, // Domestic LT tolerance (±8%)
    power_factor: { min: 0.85 },
    frequency: { min: 49.2, max: 50.8, unit: 'Hz' },
    feeder_kw_overload: 20.0,
    water_flow_leak_lpm: 10.0,
    water_pressure: { min: 1.5, unit: 'bar' }, // CPHEEO domestic terminal pressure
    tank_level_min: 10.0,
    tank_level_max: 98.0,
  },

  college_campus: {
    voltage: { min: 216.2, max: 243.8, unit: 'V' }, // CEA Standard (±6%)
    power_factor: { min: 0.90 }, // DISCOM HT-2B threshold
    frequency: { min: 49.5, max: 50.5, unit: 'Hz' },
    feeder_kw_overload: 65.0,
    water_flow_leak_lpm: 18.0,
    water_pressure: { min: 2.0, unit: 'bar' },
    tank_level_min: 15.0,
    tank_level_max: 98.0,
  },

  hospital: {
    // Life-Critical OT/ICU: tightest tolerances
    voltage: { min: 220.0, max: 240.0, unit: 'V' }, // ±4% tight band
    power_factor: { min: 0.92 },
    frequency: { min: 49.7, max: 50.3, unit: 'Hz' },
    feeder_kw_overload: 55.0,
    water_flow_leak_lpm: 12.0,
    water_pressure: { min: 2.5, unit: 'bar' }, // High pressure for RO / Dialysis / Fire safety
    tank_level_min: 30.0, // High emergency reserve buffer
    tank_level_max: 95.0,
  },

  commercial_it: {
    voltage: { min: 216.2, max: 243.8, unit: 'V' },
    power_factor: { min: 0.92 },
    frequency: { min: 49.5, max: 50.5, unit: 'Hz' },
    feeder_kw_overload: 65.0,
    water_flow_leak_lpm: 15.0,
    water_pressure: { min: 2.2, unit: 'bar' },
    tank_level_min: 20.0,
    tank_level_max: 96.0,
  },

  industrial_powerhouse: {
    voltage: { min: 216.2, max: 243.8, unit: 'V' },
    power_factor: { min: 0.95 }, // Strict HT-1 DISCOM requirement
    frequency: { min: 49.5, max: 50.5, unit: 'Hz' },
    feeder_kw_overload: 85.0,
    water_flow_leak_lpm: 25.0,
    water_pressure: { min: 3.0, unit: 'bar' }, // Process cooling feed pressure
    tank_level_min: 25.0,
    tank_level_max: 98.0,
  },
};

// ── In-Memory Alert Store ─────────────────────────────────────────────────────

/** Map<alertId, AlertRecord> */
const alerts = new Map();

/** Correlation key index: Map<dedupeKey, alertId> */
const activeDedupeMap = new Map();

/** EventEmitter for alert broadcasts (SSE / Webhooks) */
const alertEmitter = new EventEmitter();
alertEmitter.setMaxListeners(500);

let alertCounter = 1000;

function generateAlertId() {
  alertCounter += 1;
  const rand = crypto.randomBytes(2).toString('hex');
  return `alt-${alertCounter}-${rand}`;
}

// ── Notification Formatting ───────────────────────────────────────────────────

/**
 * Generate Indian TRAI DLT-compliant SMS string.
 * @param {Object} alert
 * @returns {string}
 */
function formatSmsDlt(alert) {
  const timeIST = formatIST(alert.createdAt);
  const org = alert.organization?.name || 'Facility';
  const role = alert.escalationRole || 'Duty Engineer';
  return `[ALERT - ${org}] [${alert.severity}] ${alert.title} at ${timeIST}. Dev: ${alert.deviceId}. Val: ${alert.currentValue}${alert.unit || ''} (Norm: ${alert.threshold}). Impact: ${alert.financialImpact}. Assigned: ${role}. Playbook: ${alert.actionablePlaybook}. ID: ${alert.id} - ${channelConfig.sms_dlt.senderId}`;
}

/**
 * Generate formatted WhatsApp Business notification.
 * @param {Object} alert
 * @returns {string}
 */
function formatWhatsApp(alert) {
  const icon = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'HIGH' ? '⚠️' : '📢';
  return `${icon} *FACILITY ALERT: ${alert.severity}*
*Facility:* ${alert.organization?.name || 'Campus'}
*Incident:* ${alert.title}
*Location / Feeder:* ${alert.deviceLabel} (${alert.deviceId})
*Observed Value:* ${alert.currentValue} ${alert.unit || ''} (Threshold: ${alert.threshold})
*Regulatory Reference:* ${alert.regulatoryReference}
*Financial Risk:* ${alert.financialImpact}
*Assigned Lead:* ${alert.escalationRole}
*Actionable Directive:* ${alert.actionablePlaybook}
*Incident ID:* \`${alert.id}\`
*Timestamp:* ${formatIST(alert.createdAt)} (IST)`;
}

/**
 * Generate structured incident email content.
 * @param {Object} alert
 * @returns {{ subject: string, body: string }}
 */
function formatEmail(alert) {
  const subject = `[${alert.severity}] Incident Alert: ${alert.title} - ${alert.organization?.name || 'Facility'}`;
  const body = `Dear Facilities & Engineering Team,

An automated operational threshold violation has been detected by the IoT Alert Engine.

INCIDENT DETAILS:
---------------------------------------------------------
Alert ID:               ${alert.id}
Severity:               ${alert.severity} (Priority: ${alert.priorityCode})
Incident Title:         ${alert.title}
Target Equipment:       ${alert.deviceLabel} (${alert.deviceId})
Kind:                   ${alert.kind}
Timestamp (IST):        ${formatIST(alert.createdAt)}

TELEMETRY & THRESHOLDS:
---------------------------------------------------------
Metric:                 ${alert.metric}
Observed Value:         ${alert.currentValue} ${alert.unit || ''}
Standard Limit:         ${alert.threshold} ${alert.unit || ''}
Regulatory Standard:    ${alert.regulatoryReference}

FINANCIAL & OPERATIONAL RISK:
---------------------------------------------------------
Financial Impact:       ${alert.financialImpact}
Estimated Loss/Hr:      ${alert.estimatedLossPerHour || 'N/A'}

ASSIGNED ESCALATION & PLAYBOOK:
---------------------------------------------------------
Assigned Role:          ${alert.escalationRole}
Administrative Head:    ${alert.organization?.persona?.adminTitle || 'Executive Lead'}
Recommended Action:     ${alert.actionablePlaybook}

Please log in to the Facility Control Panel to acknowledge or resolve this incident.

Automated Alert System
sensor-sim-api (India Infrastructure Edition)
`;
  return { subject, body };
}

// ── Webhook Dispatcher ────────────────────────────────────────────────────────

/**
 * Dispatch alert event to configured webhooks asynchronously without blocking.
 * @param {'alert_triggered'|'alert_updated'|'alert_resolved'|'alert_acknowledged'} eventType
 * @param {Object} alert
 */
async function dispatchWebhook(eventType, alert) {
  const url = channelConfig.webhook.url;
  if (!url || !channelConfig.webhook.enabled) return;

  const payload = JSON.stringify({
    event: eventType,
    alert,
    timestamp: new Date().toISOString(),
    istTimestamp: formatIST(new Date()),
  });

  const secret = channelConfig.webhook.secret || '';
  const signature = crypto.createHmac('sha256', secret || 'default_secret').update(payload).digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'x-alert-event': eventType,
    'x-alert-signature': signature,
    'x-webhook-secret': secret,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
  } catch (err) {
    // Do not crash on webhook delivery failure
  } finally {
    clearTimeout(timeout);
  }
}

// ── Alert Lifecycle Methods ───────────────────────────────────────────────────

/**
 * Create or update an alert.
 * @param {Object} alertData
 * @returns {Object} Alert record
 */
function raiseAlert(alertData) {
  const dedupeKey = `${alertData.deviceId}_${alertData.metric}_${alertData.ruleCode}`;
  const now = new Date();

  // If already active or acknowledged, update in place
  if (activeDedupeMap.has(dedupeKey)) {
    const existingId = activeDedupeMap.get(dedupeKey);
    const existing = alerts.get(existingId);
    if (existing && (existing.status === 'active' || existing.status === 'acknowledged')) {
      existing.currentValue = alertData.currentValue;
      existing.updatedAt = now.toISOString();
      existing.tickOccurrences = (existing.tickOccurrences || 1) + 1;
      alertEmitter.emit('alert_updated', existing);
      return existing;
    }
  }

  // Create brand new alert
  const id = generateAlertId();
  const org = getActiveProfile();
  const priorityMap = { CRITICAL: 'P1', HIGH: 'P2', MEDIUM: 'P3', LOW: 'P4' };

  const newAlert = {
    id,
    dedupeKey,
    title: alertData.title,
    severity: alertData.severity, // 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    priorityCode: priorityMap[alertData.severity] || 'P3',
    status: 'active', // 'active' | 'acknowledged' | 'silenced' | 'resolved'
    category: alertData.category, // 'Electrical', 'Hydraulic', 'CyberSecurity', 'Operational'
    metric: alertData.metric,
    currentValue: alertData.currentValue,
    threshold: alertData.threshold,
    unit: alertData.unit || '',
    ruleCode: alertData.ruleCode,
    regulatoryReference: alertData.regulatoryReference,
    financialImpact: alertData.financialImpact,
    estimatedLossPerHour: alertData.estimatedLossPerHour || null,
    deviceId: alertData.deviceId,
    deviceLabel: alertData.deviceLabel || alertData.deviceId,
    kind: alertData.kind,
    organization: {
      id: org.id,
      name: org.name,
      category: org.category,
      badge: org.badge,
      persona: org.persona,
    },
    escalationRole: alertData.escalationRole || org.persona.groundTeam,
    actionablePlaybook: alertData.actionablePlaybook,
    soundSiren: alertData.severity === 'CRITICAL' ? 'emergency_siren' : alertData.severity === 'HIGH' ? 'urgent_chime' : 'info_tone',
    notifications: {
      smsDlt: '',
      whatsapp: '',
      email: {},
    },
    tickOccurrences: 1,
    createdAt: now.toISOString(),
    createdAtIST: formatIST(now),
    updatedAt: now.toISOString(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgeNote: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    silencedUntil: null,
  };

  newAlert.notifications.smsDlt = formatSmsDlt(newAlert);
  newAlert.notifications.whatsapp = formatWhatsApp(newAlert);
  newAlert.notifications.email = formatEmail(newAlert);

  alerts.set(id, newAlert);
  activeDedupeMap.set(dedupeKey, id);

  // Broadcast & Dispatch
  alertEmitter.emit('alert_triggered', newAlert);
  dispatchWebhook('alert_started', newAlert).catch(() => {});

  return newAlert;
}

/**
 * Mark an alert as resolved.
 * @param {string} id
 * @param {Object} [details]
 * @returns {Object|null}
 */
function resolveAlert(id, details = {}) {
  const alert = alerts.get(id);
  if (!alert) return null;

  if (alert.status === 'resolved') return alert;

  alert.status = 'resolved';
  alert.resolvedAt = new Date().toISOString();
  alert.resolvedAtIST = formatIST(new Date());
  alert.resolvedBy = details.user || 'Auto-Resolution Engine';
  alert.resolutionReason = details.reason || 'Telemetry metrics returned to nominal regulatory tolerances.';

  if (activeDedupeMap.get(alert.dedupeKey) === id) {
    activeDedupeMap.delete(alert.dedupeKey);
  }

  alertEmitter.emit('alert_resolved', alert);
  dispatchWebhook('alert_resolved', alert).catch(() => {});

  return alert;
}

/**
 * Acknowledge an active alert.
 * @param {string} id
 * @param {Object} details - { user, note }
 * @returns {Object|null}
 */
function acknowledgeAlert(id, details = {}) {
  const alert = alerts.get(id);
  if (!alert) return null;

  alert.status = 'acknowledged';
  alert.acknowledgedAt = new Date().toISOString();
  alert.acknowledgedAtIST = formatIST(new Date());
  alert.acknowledgedBy = details.user || 'Duty Operator';
  alert.acknowledgeNote = details.note || 'Acknowledged by on-call engineer; field inspection dispatched.';

  alertEmitter.emit('alert_acknowledged', alert);
  dispatchWebhook('alert_acknowledged', alert).catch(() => {});

  return alert;
}

/**
 * Silence / snooze an alert for a given duration in minutes.
 * @param {string} id
 * @param {number} durationMinutes
 * @returns {Object|null}
 */
function silenceAlert(id, durationMinutes = 30) {
  const alert = alerts.get(id);
  if (!alert) return null;

  const durationMs = durationMinutes * 60 * 1000;
  alert.status = 'silenced';
  alert.silencedUntil = new Date(Date.now() + durationMs).toISOString();

  alertEmitter.emit('alert_updated', alert);
  return alert;
}

/**
 * Auto-resolve any active alert if its metric condition is no longer present.
 * @param {string} dedupeKey
 * @param {string} reason
 */
function autoResolveByKey(dedupeKey, reason) {
  if (activeDedupeMap.has(dedupeKey)) {
    const alertId = activeDedupeMap.get(dedupeKey);
    resolveAlert(alertId, { user: 'System Telemetry Engine', reason });
  }
}

// ── Core Telemetry Evaluation Pipeline ────────────────────────────────────────

/**
 * Evaluate all readings in a simulation tick against active organization rules.
 * @param {Object[]} batchReadings - Batch of readings from engine tick
 */
function evaluate(batchReadings) {
  const org = getActiveProfile();
  const rules = PROFILE_THRESHOLDS[org.id] || PROFILE_THRESHOLDS.college_campus;
  const now = new Date();
  const tod = getToDSlot(now);
  const baseRate = org.tariff?.baseRatePerKwh || DEFAULT_TARIFFS.BASE_RATE_PER_KWH;
  const effectiveRate = baseRate * tod.multiplier;
  const tankerCostPerLitre = (org.tariff?.waterTankerCostPer6000L || DEFAULT_TARIFFS.TANKER_COST_PER_6000L) / 6000;

  for (const r of batchReadings) {
    const devId = r.deviceId;
    const label = r.label || devId;
    const kind = r.kind;
    const v = r.values || {};
    const meta = r._meta || r.meta || {};
    const faultTypes = meta.faultTypes || [];

    // ── 1. Electrical Subsystem Checks (Power Meters) ───────────────────────
    if (kind === 'power_meter') {
      const voltage = v.voltage;
      const pf = v.power_factor;
      const kw = v.power_kw;
      const freq = v.frequency;

      // 1A. Voltage Sag Check
      const sagDedupe = `${devId}_voltage_sag`;
      if (voltage !== undefined && voltage < rules.voltage.min && voltage > 10) {
        const isCritical = org.id === 'hospital' || voltage < 195;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Electrical Quality',
          metric: 'voltage',
          ruleCode: 'voltage_sag',
          currentValue: parseFloat(voltage.toFixed(1)),
          threshold: `< ${rules.voltage.min} V`,
          unit: 'V',
          severity: isCritical ? 'CRITICAL' : 'HIGH',
          title: `⚠️ Voltage Sag on ${label} (${voltage.toFixed(1)} V)`,
          regulatoryReference: `CEA Grid Standards & BIS IS 12360 (Min ${rules.voltage.min} V)`,
          financialImpact: 'High risk of motor stall, coil burnout, and IT power supply tripping.',
          actionablePlaybook: `Check LT panel On-Load Tap Changer (OLTC). Inspect main phase busbar voltage. If on backup DG, adjust AVR (Automatic Voltage Regulator).`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (voltage >= rules.voltage.min) {
        autoResolveByKey(sagDedupe, 'Voltage normalized within CEA standard limits.');
      }

      // 1B. Voltage Spike Check
      const spikeDedupe = `${devId}_voltage_spike`;
      if (voltage !== undefined && voltage > rules.voltage.max) {
        const isCritical = voltage > 255 || org.id === 'hospital';
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Electrical Quality',
          metric: 'voltage',
          ruleCode: 'voltage_spike',
          currentValue: parseFloat(voltage.toFixed(1)),
          threshold: `> ${rules.voltage.max} V`,
          unit: 'V',
          severity: isCritical ? 'CRITICAL' : 'HIGH',
          title: `⚡ Overvoltage Spike on ${label} (${voltage.toFixed(1)} V)`,
          regulatoryReference: `CEA Grid Standards (Max ${rules.voltage.max} V)`,
          financialImpact: 'Dielectric breakdown hazard; catastrophic failure of sensitive SMPS power supplies.',
          actionablePlaybook: `Isolate surge protection device (SPD) failure. Step down transformer tap switch immediately.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (voltage <= rules.voltage.max) {
        autoResolveByKey(spikeDedupe, 'Voltage returned to safe nominal CEA operating limits.');
      }

      // 1C. Blackout / Feeder Loss
      const blackoutDedupe = `${devId}_power_blackout`;
      if (faultTypes.includes('blackout') || (voltage < 10 && kw === 0)) {
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Electrical Supply',
          metric: 'power_kw',
          ruleCode: 'power_blackout',
          currentValue: 0,
          threshold: 'Supply Continuity (0 kW detected)',
          unit: 'kW',
          severity: 'CRITICAL',
          title: `🚨 TOTAL BLACKOUT on ${label}`,
          regulatoryReference: `CEA Standard for Continuity of Supply (Sec 5)`,
          financialImpact: org.id === 'hospital' ? 'LIFE-CRITICAL EMERGENCY: Operation Theatres & ICU Feeder Down.' : 'Complete productivity shutdown.',
          actionablePlaybook: `Auto-start standby DG Set sync. Transfer through AMF (Auto Main Failure) breaker panel. Verify UPS battery bank discharge.`,
          escalationRole: org.persona.leadEngineer || org.persona.groundTeam,
        });
      } else if (!faultTypes.includes('blackout') && voltage > 180) {
        autoResolveByKey(blackoutDedupe, 'Grid supply restored.');
      }

      // 1D. DISCOM Power Factor Penalty Alert
      const pfDedupe = `${devId}_power_factor_drop`;
      if (pf !== undefined && pf < rules.power_factor.min) {
        const pfEval = calculatePFPenalty(pf, 50000, baseRate);
        const isSevere = pf < 0.80 || org.id === 'industrial_powerhouse';
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'DISCOM Compliance',
          metric: 'power_factor',
          ruleCode: 'power_factor_drop',
          currentValue: parseFloat(pf.toFixed(3)),
          threshold: `< ${rules.power_factor.min}`,
          unit: 'PF',
          severity: isSevere ? 'HIGH' : 'MEDIUM',
          title: `📉 DISCOM Power Factor Surcharge Alert (${label}: ${pf.toFixed(2)})`,
          regulatoryReference: `State Electricity Regulatory Commission (SERC) HT Tariff Regulations`,
          financialImpact: `${pfEval.explanation} Approx. ${formatINR(pfEval.monthlyAmountINR)}/month surcharge.`,
          estimatedLossPerHour: formatINR(Math.round(pfEval.monthlyAmountINR / 720)),
          actionablePlaybook: `Dispatch ${org.persona.groundTeam} to check APFC (Automatic Power Factor Correction) bank. Replace blown capacitor steps and contactors.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (pf >= rules.power_factor.min) {
        autoResolveByKey(pfDedupe, 'Power Factor compliant with DISCOM benchmark.');
      }

      // 1E. Feeder Overload / Maximum Demand
      const overloadDedupe = `${devId}_power_kw_overload`;
      if (kw !== undefined && kw > rules.feeder_kw_overload) {
        const isHigh = kw > rules.feeder_kw_overload * 1.3;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Demand Management',
          metric: 'power_kw',
          ruleCode: 'power_kw_overload',
          currentValue: parseFloat(kw.toFixed(1)),
          threshold: `> ${rules.feeder_kw_overload} kW`,
          unit: 'kW',
          severity: isHigh ? 'HIGH' : 'MEDIUM',
          title: `🔥 Feeder Overload on ${label} (${kw.toFixed(1)} kW)`,
          regulatoryReference: `Contracted Maximum Demand (CMD) Tariff Threshold`,
          financialImpact: `Contributes ${formatINR(Math.round(kw * effectiveRate))}/hr. Incurs 150% penalty if campus exceeds CMD.`,
          actionablePlaybook: `Stagger heavy equipment duty cycles (chillers, compressors, pumping sets). Verify phase current balance across R-Y-B phases.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (kw <= rules.feeder_kw_overload) {
        autoResolveByKey(overloadDedupe, 'Feeder load within rated continuous capacity.');
      }

      // 1F. Frequency Drift
      const freqDedupe = `${devId}_frequency_drift`;
      if (freq !== undefined && (freq < rules.frequency.min || freq > rules.frequency.max)) {
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Grid Quality',
          metric: 'frequency',
          ruleCode: 'frequency_drift',
          currentValue: parseFloat(freq.toFixed(3)),
          threshold: `${rules.frequency.min} - ${rules.frequency.max} Hz`,
          unit: 'Hz',
          severity: 'HIGH',
          title: `⚡ Grid Frequency Drift on ${label} (${freq.toFixed(2)} Hz)`,
          regulatoryReference: `Indian Electricity Grid Code (IEGC Section 5.2)`,
          financialImpact: 'Threatens motor speed synchronism, clock accuracy, and turbine stability.',
          actionablePlaybook: `Notify state SLDC / DISCOM grid control room. If islanded on captive DG, adjust generator governor speed governor.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (freq >= rules.frequency.min && freq <= rules.frequency.max) {
        autoResolveByKey(freqDedupe, 'Grid frequency stabilized within IEGC statutory limits.');
      }
    }

    // ── 2. Hydraulic Subsystem Checks (Water Tanks) ─────────────────────────
    if (kind === 'water_tank') {
      const lpm = v.flow_lpm || 0;
      const bar = v.pressure_bar;
      const level = v.tank_level_percent;
      const hasLeakFlag = v.leak_detected || faultTypes.includes('leak') || faultTypes.includes('burst');

      // 2A. Pipe Burst / Uncontrolled Water Leak
      const leakDedupe = `${devId}_water_leak`;
      const isBurst = faultTypes.includes('burst') || lpm > 60;
      const isSignificantLeak = hasLeakFlag || lpm > rules.water_flow_leak_lpm;

      if (isSignificantLeak) {
        const hourlyLoss = Math.round(lpm * 60);
        const hourlyCostINR = Math.round(hourlyLoss * tankerCostPerLitre);
        const tankersPerHour = (hourlyLoss / 6000).toFixed(2);

        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Conservation',
          metric: 'flow_lpm',
          ruleCode: 'water_leak',
          currentValue: parseFloat(lpm.toFixed(1)),
          threshold: `> ${rules.water_flow_leak_lpm} LPM`,
          unit: 'LPM',
          severity: isBurst ? 'CRITICAL' : 'HIGH',
          title: `${isBurst ? '💥 CATASTROPHIC PIPE BURST' : '💧 Active Water Leak'} on ${label}`,
          regulatoryReference: `CPHEEO Water Loss Reduction Norm & NBC 2016`,
          financialImpact: `Wasting ~${hourlyLoss.toLocaleString('en-IN')} L/hr (~${formatINR(hourlyCostINR)}/hr in private tanker replacement, ~${tankersPerHour} tankers/hr).`,
          estimatedLossPerHour: formatINR(hourlyCostINR),
          actionablePlaybook: `Dispatch ${org.persona.groundTeam} immediately to isolate sector valve upstream of ${devId}. Shut down booster transfer pump.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (lpm <= rules.water_flow_leak_lpm && !hasLeakFlag) {
        autoResolveByKey(leakDedupe, 'Water flow rate normal; leak isolated.');
      }

      // 2B. Low Supply Pressure
      const pressDedupe = `${devId}_low_pressure`;
      if (bar !== undefined && bar < rules.water_pressure.min) {
        const isCriticalPress = org.id === 'hospital' || bar < 1.0;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Quality',
          metric: 'pressure_bar',
          ruleCode: 'low_pressure',
          currentValue: parseFloat(bar.toFixed(2)),
          threshold: `< ${rules.water_pressure.min} bar`,
          unit: 'bar',
          severity: isCriticalPress ? 'CRITICAL' : 'MEDIUM',
          title: `📉 Low Hydraulic Pressure on ${label} (${bar.toFixed(2)} bar)`,
          regulatoryReference: `CPHEEO Manual on Water Supply (Minimum tap terminal pressure: ${rules.water_pressure.min} bar)`,
          financialImpact: org.id === 'hospital' ? 'CRITICAL: Inadequate water pressure for Dialysis RO plants & fire safety hydrants.' : 'Loss of upper floor gravity feed.',
          actionablePlaybook: `Inspect hydropneumatic booster pump sets. Check for line airlocks and suction filter clogging.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (bar >= rules.water_pressure.min) {
        autoResolveByKey(pressDedupe, 'Hydraulic pressure restored to CPHEEO standards.');
      }

      // 2B-2. Pump Power / Pressure Degradation (Virtual Ultrasonic Profiling)
      const pumpDegradeDedupe = `${devId}_pump_power_degraded`;
      if (v.virtual_pump_sensor?.pump_pressure_status === 'DEGRADED_PRESSURE' && v.virtual_pump_sensor.inferred_pump_active) {
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Asset Health',
          metric: 'pump_power_efficiency_pct',
          ruleCode: 'pump_power_degraded',
          currentValue: `${v.virtual_pump_sensor.pump_power_efficiency_pct}%`,
          threshold: `< 55% of trained baseline`,
          unit: '%',
          severity: 'MEDIUM',
          title: `⚠️ PUMP PRESSURE DEGRADATION: ${label} filling at only ${v.virtual_pump_sensor.pump_power_efficiency_pct}% of baseline power`,
          regulatoryReference: `Bureau of Energy Efficiency (BEE) Building Pump Efficiency Norms`,
          financialImpact: 'Pump running 2x longer to fill tank; excess kWh motor consumption and risk of dry-run coil burn.',
          actionablePlaybook: `Observed fill rate is only +${v.virtual_pump_sensor.rate_of_change_pct_min}%/min (baseline is ${v.learned_fill_profile?.baseline_fill_rate_pct_min}%/min). Check for low supply voltage, borewell water table depletion, or suction pipe cavitation.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (v.virtual_pump_sensor?.pump_pressure_status === 'NOMINAL') {
        autoResolveByKey(pumpDegradeDedupe, 'Pump refill velocity restored to trained baseline efficiency.');
      }

      // 2C. Imminent Overflow Hazard (AI Predictive Warning)
      const immedOverflowDedupe = `${devId}_overflow_imminent`;
      if (v.pump_active && v.predictions?.eta_overflow_seconds !== null && v.predictions?.eta_overflow_seconds <= 600 && !v.is_overflowing) {
        const isUrgent = v.predictions.eta_overflow_seconds <= 180;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Conservation',
          metric: 'eta_overflow_seconds',
          ruleCode: 'overflow_imminent',
          currentValue: v.predictions.eta_overflow_formatted,
          threshold: `Overflow in <= 10 mins`,
          unit: '',
          severity: isUrgent ? 'CRITICAL' : 'HIGH',
          title: `⏱️ IMMINENT OVERFLOW: ${label} will overflow in ${v.predictions.eta_overflow_formatted}!`,
          regulatoryReference: `CPHEEO Urban Water Conservation & Sump-OHT Automation Norms`,
          financialImpact: 'Water spillage from terrace hazard; wastage of electricity and pumped potable water.',
          actionablePlaybook: `Tank level is currently ${level}%. At net fill rate (+${v.net_flow_lpm} L/min), tank will spill over at ${v.predictions.expected_overflow_time}. Cut off pump switch now!`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (!v.pump_active || (v.predictions?.eta_overflow_seconds > 600)) {
        autoResolveByKey(immedOverflowDedupe, 'Pump switched off or overflow hazard averted.');
      }

      // 2D. Active Tank Overflow (Water Spilling onto Terrace/Roof)
      const overflowDedupe = `${devId}_tank_overflow`;
      if (v.is_overflowing || level >= 100 || level > rules.tank_level_max) {
        const isSpilling = v.is_overflowing || level >= 99.5;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Conservation',
          metric: 'tank_level_percent',
          ruleCode: 'tank_overflow',
          currentValue: parseFloat(level.toFixed(1)),
          threshold: `> ${rules.tank_level_max}%`,
          unit: '%',
          severity: isSpilling ? 'CRITICAL' : 'HIGH',
          title: `${isSpilling ? '🌊 ACTIVE TANK OVERFLOW (Spilling Water)' : '🌊 Overhead Tank Overflow'} on ${label}`,
          regulatoryReference: `CPHEEO & Municipal Water Conservation Guidelines`,
          financialImpact: 'Structural seepage risk and continuous wastage of pumped potable water.',
          estimatedLossPerHour: formatINR(Math.round(35 * 60 * tankerCostPerLitre)),
          actionablePlaybook: `Cut off UG Sump-to-OHT transfer pump immediately. Inspect float sensor switch and overflow ball valve.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (level <= rules.tank_level_max && !v.is_overflowing) {
        autoResolveByKey(overflowDedupe, 'Tank level within safe operating buffer.');
      }

      // 2E. Temporal Rapid Drainage Anomaly ("Full 2hr ago, now 10% = Major Leak")
      const rapidDrainDedupe = `${devId}_temporal_rapid_drain`;
      if (v.temporal_analysis?.rapid_drain_anomaly) {
        const drop = v.temporal_analysis.delta_level_2h;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Integrity',
          metric: 'delta_level_2h',
          ruleCode: 'temporal_rapid_drain',
          currentValue: `-${drop}% in 2h`,
          threshold: `Max expected drain: <= 25%`,
          unit: '',
          severity: drop > 65 ? 'CRITICAL' : 'HIGH',
          title: `🚨 AI TEMPORAL LEAK DETECTED: ${label} crashed by ${drop}% in 2 hours!`,
          regulatoryReference: `CPHEEO Unaccounted-for-Water (UFW) Non-Revenue Reduction Standards`,
          financialImpact: 'Severe subterranean rupture or main isolation gate valve stuck open.',
          actionablePlaybook: `${v.temporal_analysis.rapid_drain_explanation || 'Tank level crashed abruptly compared to historical level.'} Dispatch plumbers immediately to inspect feeder lines.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (v.temporal_analysis && !v.temporal_analysis.rapid_drain_anomaly) {
        autoResolveByKey(rapidDrainDedupe, 'Tank drainage velocity returned to normal diurnal patterns.');
      }

      // 2F. Imminent Run-Out / Tank Depletion (Dry Hazard)
      const dryDedupe = `${devId}_tank_dry`;
      const isImminentDry = !v.pump_active && v.predictions?.eta_empty_seconds !== null && v.predictions?.eta_empty_seconds <= 1800 && level < 25;
      if (level !== undefined && (level < rules.tank_level_min || isImminentDry)) {
        const isCriticalDry = org.id === 'hospital' || level < 5;
        raiseAlert({
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Continuity',
          metric: 'tank_level_percent',
          ruleCode: 'tank_dry',
          currentValue: parseFloat(level.toFixed(1)),
          threshold: `< ${rules.tank_level_min}%`,
          unit: '%',
          severity: isCriticalDry ? 'CRITICAL' : 'HIGH',
          title: isImminentDry && level >= rules.tank_level_min
            ? `🪣 RUN-OUT IMMINENT: ${label} will be dry in ${v.predictions.eta_empty_formatted}!`
            : `🪣 Tank Depletion (Dry Hazard) on ${label} (${level.toFixed(1)}%)`,
          regulatoryReference: `NBC 2016 Fire & Potable Reserve Storage Requirements`,
          financialImpact: 'Risk of dry pump impeller burnout; facility water outage.',
          actionablePlaybook: `Engage emergency borewell or municipal inflow pump. Interlock booster pumps to prevent dry-running cavitation.`,
          escalationRole: org.persona.groundTeam,
        });
      } else if (level >= rules.tank_level_min && !isImminentDry) {
        autoResolveByKey(dryDedupe, 'Tank replenished to safe operating level.');
      }
    }

    // ── 3. Cyber-Physical Attacks & Device Tampering Checks ─────────────────
    const attackDedupe = `${devId}_cyber_security`;
    const cyberThreats = faultTypes.filter(t =>
      ['spoofed_sensor', 'replay_attack', 'out_of_range', 'value_injection', 'duplicate_flood', 'clock_skew', 'missing_heartbeat'].includes(t)
    );

    if (cyberThreats.length > 0) {
      const threatName = cyberThreats.join(', ');
      raiseAlert({
        deviceId: devId,
        deviceLabel: label,
        kind,
        category: 'Cyber-Physical Security',
        metric: 'data_integrity',
        ruleCode: 'cyber_security',
        currentValue: threatName,
        threshold: 'Cryptographic HMAC & Sequence Verification',
        unit: '',
        severity: 'CRITICAL',
        title: `🛡️ CYBER-PHYSICAL ATTACK Flagged on ${label} (${threatName})`,
        regulatoryReference: `CERT-In Industrial IoT Guidelines & ISO/IEC 27001`,
        financialImpact: 'Data corruption risk; manipulated telemetry masks physical overflows and audit records.',
        actionablePlaybook: `Quarantine sensor telemetry channel. Invalidate current HMAC secret via POST /api/claim. Inspect edge switch port for rogue MAC addresses.`,
        escalationRole: 'Chief Information Security Officer (CISO) & IT Network Lead',
      });
    } else if (cyberThreats.length === 0) {
      autoResolveByKey(attackDedupe, 'Cryptographic and sequential integrity verified.');
    }
  }
}

// ── Public Query & Management API ─────────────────────────────────────────────

/**
 * Get active alerts with optional filtering.
 * @param {Object} [filter] - { status, severity, deviceId, limit }
 * @returns {Object[]}
 */
function getAlerts(filter = {}) {
  let list = Array.from(alerts.values());

  // Default to non-resolved unless explicitly requested
  if (filter.status) {
    if (filter.status !== 'all') {
      list = list.filter(a => a.status === filter.status);
    }
  } else {
    list = list.filter(a => a.status === 'active' || a.status === 'acknowledged');
  }

  if (filter.severity) {
    list = list.filter(a => a.severity.toLowerCase() === filter.severity.toLowerCase());
  }

  if (filter.deviceId) {
    list = list.filter(a => a.deviceId === filter.deviceId);
  }

  // Newest first
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filter.limit) {
    list = list.slice(0, parseInt(filter.limit, 10));
  }

  return list;
}

/**
 * Get real-time alert summary & health score.
 * @returns {Object}
 */
function getSummary() {
  const all = Array.from(alerts.values());
  const active = all.filter(a => a.status === 'active' || a.status === 'acknowledged');

  const critical = active.filter(a => a.severity === 'CRITICAL').length;
  const high = active.filter(a => a.severity === 'HIGH').length;
  const medium = active.filter(a => a.severity === 'MEDIUM').length;
  const low = active.filter(a => a.severity === 'LOW').length;
  const unacknowledged = active.filter(a => a.status === 'active').length;

  let healthScore = 100 - (critical * 20 + high * 10 + medium * 5 + low * 2);
  healthScore = Math.max(10, Math.min(100, healthScore));

  const org = getActiveProfile();

  return {
    timestamp: new Date().toISOString(),
    istTimestamp: formatIST(new Date()),
    organization: {
      id: org.id,
      name: org.name,
      badge: org.badge,
    },
    totalActive: active.length,
    unacknowledged,
    bySeverity: {
      critical,
      high,
      medium,
      low,
    },
    healthScore,
    statusLevel: critical > 0 ? 'CRITICAL_ALERT' : high > 0 ? 'HIGH_WARNING' : medium > 0 ? 'ATTENTION_NEEDED' : 'OPTIMAL',
    channels: channelConfig,
  };
}

/**
 * Trigger an end-to-end simulated test alert across all channels.
 * @param {Object} [params] - { severity, title }
 * @returns {Object} Test alert record
 */
function triggerTestAlert(params = {}) {
  const org = getActiveProfile();
  const sev = params.severity || 'CRITICAL';
  const title = params.title || `🚨 [END-TO-END TEST] Emergency Verification Alert - ${org.name}`;

  return raiseAlert({
    deviceId: 'dev-TEST-ALERT',
    deviceLabel: `${org.name} - Main Test Feeder`,
    kind: 'power_meter',
    category: 'System Diagnostics',
    metric: 'test_simulation',
    ruleCode: 'test_diagnostic',
    currentValue: 'Triggered',
    threshold: 'Manual Test Protocol',
    unit: '',
    severity: sev,
    title,
    regulatoryReference: 'National Disaster Management Authority (NDMA) Mock Drill Standards',
    financialImpact: 'Test execution — No financial loss.',
    actionablePlaybook: 'Verify SSE reception, sound sirens, and external webhook notification payloads.',
    escalationRole: org.persona.leadEngineer || 'Chief Operating Engineer',
  });
}

/**
 * Get active threshold rules for current organization profile.
 * @returns {Object}
 */
function getActiveRules() {
  const org = getActiveProfile();
  return {
    organization: org.id,
    thresholds: PROFILE_THRESHOLDS[org.id] || PROFILE_THRESHOLDS.college_campus,
  };
}

/**
 * Update threshold rules in memory.
 * @param {Object} newThresholds
 * @returns {Object}
 */
function updateRules(newThresholds = {}) {
  const org = getActiveProfile();
  PROFILE_THRESHOLDS[org.id] = {
    ...PROFILE_THRESHOLDS[org.id],
    ...newThresholds,
  };
  return getActiveRules();
}

/**
 * Configure notification channels.
 * @param {Object} cfg
 * @returns {Object}
 */
function setChannelConfig(cfg = {}) {
  if (cfg.webhook) {
    Object.assign(channelConfig.webhook, cfg.webhook);
  }
  if (cfg.sms_dlt) {
    Object.assign(channelConfig.sms_dlt, cfg.sms_dlt);
  }
  if (cfg.whatsapp) {
    Object.assign(channelConfig.whatsapp, cfg.whatsapp);
  }
  if (cfg.email) {
    Object.assign(channelConfig.email, cfg.email);
  }
  if (cfg.audio) {
    Object.assign(channelConfig.audio, cfg.audio);
  }
  return channelConfig;
}

module.exports = {
  emitter: alertEmitter,
  evaluate,
  raiseAlert,
  resolveAlert,
  acknowledgeAlert,
  silenceAlert,
  triggerTestAlert,
  getAlerts,
  getAlertById: id => alerts.get(id) || null,
  getSummary,
  getActiveRules,
  updateRules,
  getChannelConfig: () => channelConfig,
  setChannelConfig,
  PROFILE_THRESHOLDS,
};
