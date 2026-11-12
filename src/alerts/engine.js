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
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {
  try {
    nodemailer = require('D:/waste-management/Waste-Management/backend/node_modules/nodemailer');
  } catch (__) {}
}

const {
  GRID_STANDARDS,
  DEFAULT_TARIFFS,
  formatINR,
  formatIST,
  calculatePFPenalty,
  getToDSlot,
} = require('../drishti/india-standards');
const { getActiveProfile } = require('../drishti/org-profiles');

// ── Sensor Alias Mapping (Simulator <-> Facility 3D Digital Twin) ────────────
const SENSOR_ALIASES = {
  'dev-bldA-pwr-f1': 'PWR-HA-F1',
  'dev-bldA-pwr-f2': 'PWR-HA-F2',
  'dev-bldA-pwr-f3': 'PWR-HA-F3',
  'dev-bldA-pwr-f4': 'PWR-HA-F4',
  'dev-bldA-wat-t1': 'WTR-HA-T1',
  'dev-bldA-wat-t2': 'WTR-HA-T2',
  'dev-acad-pwr-1': 'PWR-AB-F1',
  'dev-acad-pwr-2': 'PWR-AB-F2',
  'dev-acad-pwr-3': 'PWR-AB-F3',
  'dev-acad-wat-1': 'WTR-AB-T1',
  'dev-acad-wat-2': 'WTR-AB-T2',
  'dev-acad-wat-3': 'WTR-AB-T3',
  'dev-lib-pwr-1': 'PWR-LIB-F1',
  'dev-lib-pwr-2': 'PWR-LIB-F2',
  'dev-lib-wat-1': 'WTR-LIB-T1',
  'dev-lib-wat-2': 'WTR-LIB-T2',
  'dev-lab-pwr-1': 'PWR-LAB-F1',
  'dev-lab-pwr-2': 'PWR-LAB-F2',
  'dev-lab-pwr-3': 'PWR-LAB-F3',
  'dev-lab-wat-1': 'WTR-LAB-T1',
  'dev-lab-wat-2': 'WTR-LAB-T2',
  'dev-lab-wat-3': 'WTR-LAB-T3',
  'dev-lab-wat-4': 'WTR-LAB-T4',
  'dev-bldA-wst-bin': 'WST-HA-BIN',
  'dev-acad-wst-comp': 'WST-AB-COMP',
  'dev-mess-wst-compost': 'WST-CANT-COMP',
  'dev-lab-wst-hazard': 'WST-LAB-HAZ',
};

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
    service: 'gmail',
    user: (process.env.GMAIL_USER || 'ardiliumplatform@gmail.com').trim(),
    pass: (process.env.GMAIL_PASS || '').replace(/\s+/g, ''),
    recipient: (process.env.ALERT_EMAIL_RECIPIENT || process.env.GMAIL_USER || 'ardiliumplatform@gmail.com').trim(),
    supportEmail: (process.env.GMAIL_USER || 'ardiliumplatform@gmail.com').trim(),
    batchWindowMs: parseInt(process.env.ALERT_BATCH_WINDOW_MS, 10) || 4000,
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
 * @returns {{ subject: string, body: string, html: string }}
 */
const PORTAL_URL = (process.env.FRONTEND_URL || process.env.PORTAL_URL || 'https://greenloop-org.vercel.app').replace(/\/+$/, '');

function formatEmail(alert) {
  const org = alert.organization?.name || 'Facility';
  const subject = `[${alert.severity}] Incident Alert: ${alert.title} - ${org}`;
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #ef4444; border-radius: 12px; padding: 24px; max-width: 680px; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .badge { background: #ef4444; color: #fff; font-size: 11px; padding: 3px 8px; border-radius: 9999px; font-weight: bold; text-transform: uppercase; }
    h1 { font-size: 18px; color: #fff; margin: 10px 0; }
    .meta { font-size: 12px; color: #94a3b8; margin-bottom: 16px; }
    .box { background: #0f172a; padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; margin: 14px 0; }
    .btn { display: inline-block; background: #0284c7; color: #fff; text-decoration: none; font-weight: bold; padding: 8px 16px; border-radius: 6px; font-size: 12px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${alert.severity} · ${alert.priorityCode}</span>
    <h1>${alert.title}</h1>
    <div class="meta">Facility: <strong>${org}</strong> | Time: ${formatIST(alert.createdAt)} (IST)</div>
    <div class="box">
      <strong>Target Feeder/Tank:</strong> ${alert.deviceLabel} (<code>${alert.deviceId}</code>)<br/>
      <strong>Observed Telemetry:</strong> <span style="color: #f87171; font-weight: bold;">${alert.currentValue} ${alert.unit || ''}</span> (Regulatory Limit: ${alert.threshold})<br/>
      <strong>Financial / Risk Impact:</strong> ${alert.financialImpact}<br/>
      <strong>Standard:</strong> ${alert.regulatoryReference}<br/>
      <strong>Action Playbook:</strong> ${alert.actionablePlaybook}
    </div>
    <div style="text-align: center;">
      <a href="${PORTAL_URL}" class="btn">Inspect in 3D Campus Digital Twin</a>
    </div>
  </div>
</body>
</html>
  `;

  return { subject, body, html };
}

/**
 * Generate consolidated HTML email when MULTIPLE sensors cross their envelopes simultaneously.
 * @param {Object[]} batch
 * @param {Object} org
 * @returns {{ subject: string, html: string, text: string }}
 */
function formatMultiSensorBatchEmail(batch, org) {
  const timeIST = formatIST(new Date());
  const subject = `🚨 [MULTI-SENSOR CONSOLIDATED ALERT] ${batch.length} Critical Faults/Overloads at ${org.name}`;

  const rows = batch.map((alert, idx) => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 10px; font-family: monospace; font-weight: bold; color: #38bdf8;">${alert.deviceLabel || alert.deviceId}</td>
      <td style="padding: 10px; color: #f87171; font-weight: bold;">${alert.currentValue} ${alert.unit || ''}</td>
      <td style="padding: 10px; color: #94a3b8;">${alert.threshold}</td>
      <td style="padding: 10px;"><span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">${alert.severity}</span></td>
      <td style="padding: 10px; color: #cbd5e1; font-size: 12px;">${alert.breachDurationSec ? `${alert.breachDurationSec}s sustained` : 'Active'}</td>
      <td style="padding: 10px; color: #e2e8f0; font-size: 12px;">${alert.actionablePlaybook}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b1120; color: #f8fafc; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #ef4444; border-radius: 12px; padding: 24px; max-width: 780px; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .header { border-bottom: 1px solid #334155; padding-bottom: 16px; margin-bottom: 20px; }
    .badge { display: inline-block; background: #ef4444; color: #ffffff; font-weight: bold; font-size: 11px; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.05em; }
    h1 { font-size: 20px; margin: 12px 0 6px 0; color: #ffffff; }
    .meta { font-size: 13px; color: #94a3b8; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px; text-align: left; }
    th { background: #0f172a; padding: 10px; color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
    .callout { background: rgba(239, 68, 68, 0.1); border-left: 4px solid #ef4444; padding: 14px; border-radius: 4px; margin: 18px 0; font-size: 13px; color: #fca5a5; }
    .btn { display: inline-block; background: #0284c7; color: #ffffff; text-decoration: none; font-weight: bold; padding: 10px 20px; border-radius: 6px; font-size: 13px; margin-top: 10px; }
    .footer { font-size: 11px; color: #64748b; margin-top: 24px; text-align: center; border-top: 1px solid #334155; padding-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <span class="badge">🚨 Consolidated Multi-Sensor Envelope Breach</span>
      <h1>Urgent: ${batch.length} Feeders Exceeded Operational Envelope</h1>
      <div class="meta">Facility: <strong>${org.name}</strong> · Timestamp: <strong>${timeIST} (IST)</strong> · Protocol: Indian Infrastructure Standards</div>
    </div>

    <div class="callout">
      <strong>OPERATIONAL RISK DETECTED:</strong> Telemetry sustained above rated continuous capacity across multiple circuits simultaneously. High probability of upstream circuit breaker tripping, DISCOM Maximum Demand surcharge (150% tariff penalty), and transformer thermal stress.
    </div>

    <table>
      <thead>
        <tr>
          <th>Feeder / Equipment</th>
          <th>Observed</th>
          <th>Threshold</th>
          <th>Severity</th>
          <th>Sustained Duration</th>
          <th>Action Playbook</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div style="background: #0f172a; border-radius: 8px; padding: 14px; font-size: 12px; line-height: 1.6; color: #cbd5e1;">
      <div style="color: #38bdf8; font-weight: bold; margin-bottom: 4px;">⚡ Immediate Triage Protocol:</div>
      1. Inspect Main LT Panel busbar and feeder distribution breakers.<br/>
      2. Stagger non-essential HVAC chillers and heavy pump loads immediately.<br/>
      3. Verify load balancing across R-Y-B phases to prevent neutral overheating.
    </div>

    <div style="text-align: center; margin-top: 20px;">
      <a href="${PORTAL_URL}" class="btn">Open 3D Campus Digital Twin & Facility Control</a>
    </div>

    <div class="footer">
      GreenLoop SCADA & Enterprise Telemetry Monitoring System · Automated Delivery via Gmail · Incident Reference Batch #${Date.now().toString().slice(-6)}
    </div>
  </div>
</body>
</html>
  `;

  const text = `CONSOLIDATED MULTI-SENSOR ALERT: ${batch.length} sensors exceeded operational envelope at ${org.name}.\n\n` +
    batch.map(a => `- ${a.deviceLabel} (${a.deviceId}): ${a.currentValue}${a.unit || ''} (Limit: ${a.threshold}) - ${a.actionablePlaybook}`).join('\n');

  return { subject, html, text };
}

// ── Email Notification Dispatcher & Batch Aggregator ──────────────────────────

const emailDispatchLogs = [];
const pendingEmailBatch = new Map(); // alertId -> alert
let batchEmailTimer = null;

async function fetchApprovedSubscribers() {
  if (process.env.NODE_ENV === 'test') return [];
  const backendBase = (process.env.CENTRAL_BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  const org = getActiveProfile();
  const activeOrgId = org?.id === 'hospital' ? 'city_hospital' : 'bput_college';
  const orgIds = [activeOrgId];
  const allSubs = [];
  for (const orgId of orgIds) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1800);
      const res = await fetch(`${backendBase}/api/actions/notification-subscribers?orgId=${orgId}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          list.filter(s => s.active && s.approvalStatus === 'approved' && s.email).forEach(s => allSubs.push(s));
        }
      }
    } catch (_) {
      // Central backend offline or unreachable — proceed seamlessly
    }
  }
  return allSubs;
}

function doesAlertMatchSubscriber(alert, subscriber) {
  const topics = subscriber.topics || [];
  if (topics.length === 0) return true; // General catch-all subscriber
  const alertDomain = alert.kind === 'water_tank' ? 'water'
    : (alert.kind === 'waste_bin' || alert.kind === 'waste_compactor' ? 'waste' : 'power');
  const ruleLower = (alert.ruleCode || '').toLowerCase();

  for (const t of topics) {
    const types = Array.isArray(t.alertTypes) ? t.alertTypes.map(x => String(x).toLowerCase()) : [];
    const nameLower = String(t.name || '').toLowerCase();
    if (types.includes('all') || types.length === 0) return true;
    if (alertDomain === 'power' && (types.some(x => x.includes('power') || x.includes('overload')) || nameLower.includes('power'))) return true;
    if (alertDomain === 'water' && (types.some(x => x.includes('water') || x.includes('tank') || x.includes('leak')) || nameLower.includes('water') || nameLower.includes('hydraulic'))) return true;
    if (alertDomain === 'waste' && (types.some(x => x.includes('waste')) || nameLower.includes('waste'))) return true;
    if (ruleLower && types.includes(ruleLower)) return true;
  }
  return false;
}

/**
 * Dispatch an email notification payload via Gmail SMTP or mock fallback.
 * @param {Object} payload - { subject, html, text, alertCount, to }
 * @returns {Promise<Object>} Log record
 */
async function dispatchEmailNotification(payload) {
  const gmailUser = (channelConfig.email.user || process.env.GMAIL_USER || 'ardiliumplatform@gmail.com').trim();
  const gmailPass = (channelConfig.email.pass || process.env.GMAIL_PASS || '').replace(/\s+/g, '');
  const recipient = (payload.to || channelConfig.email.recipient || process.env.ALERT_EMAIL_RECIPIENT || gmailUser).trim();

  const logRecord = {
    id: `eml-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    recipient,
    recipientName: payload.recipientName || 'Facility Admin',
    recipientRole: payload.recipientRole || 'Chief Engineer',
    subject: payload.subject,
    alertCount: payload.alertCount || 1,
    sensorIds: payload.sensorIds || [],
    status: 'pending',
    error: null,
  };

  if (process.env.NODE_ENV === 'test' || !nodemailer || !gmailUser || !gmailPass) {
    logRecord.status = 'simulated';
    logRecord.note = 'Gmail transport simulated (logged in dispatch history)';
    emailDispatchLogs.unshift(logRecord);
    if (emailDispatchLogs.length > 100) emailDispatchLogs.pop();
    return logRecord;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });

    const info = await transporter.sendMail({
      from: `"GreenLoop SCADA Alerts" <${gmailUser}>`,
      to: recipient,
      subject: payload.subject,
      html: payload.html,
      text: payload.text || payload.subject,
    });

    logRecord.status = 'sent';
    logRecord.messageId = info?.messageId;
    emailDispatchLogs.unshift(logRecord);
    if (emailDispatchLogs.length > 100) emailDispatchLogs.pop();
    console.log(`📧 [ALERT EMAIL DISPATCHED] (${logRecord.alertCount} sensor(s)) "${payload.subject}" -> ${recipient}`);
    return logRecord;
  } catch (err) {
    console.error('⚠️ [ALERT EMAIL ERROR] Gmail SMTP delivery failed:', err.message);
    logRecord.status = 'failed';
    logRecord.error = err.message;
    emailDispatchLogs.unshift(logRecord);
    if (emailDispatchLogs.length > 100) emailDispatchLogs.pop();
    return logRecord;
  }
}

/**
 * Queue an alert for batched multi-sensor email delivery.
 * @param {Object} alert
 */
function queueAlertForBatchEmail(alert) {
  if (!channelConfig.email.enabled) return;
  pendingEmailBatch.set(alert.id, alert);

  if (!batchEmailTimer) {
    const windowMs = channelConfig.email.batchWindowMs || 4000;
    batchEmailTimer = setTimeout(() => {
      batchEmailTimer = null;
      flushAlertBatchEmail().catch(err => {
        console.error('⚠️ [EMAIL BATCH] Error delivering batched alert email:', err.message);
      });
    }, windowMs);
  }
}

/**
 * Flush all currently pending alerts and send a single consolidated email per recipient
 * when multiple sensors breach simultaneously.
 * @returns {Promise<Object|null>}
 */
async function flushAlertBatchEmail() {
  if (pendingEmailBatch.size === 0) return null;
  const batch = Array.from(pendingEmailBatch.values());
  pendingEmailBatch.clear();

  const org = getActiveProfile();
  const subscribers = await fetchApprovedSubscribers();

  // Build map: recipientEmail -> { name, role, alerts: [] }
  const recipientMap = new Map();
  const primaryRecipient = (channelConfig.email.recipient || process.env.ALERT_EMAIL_RECIPIENT || channelConfig.email.user || 'ardiliumplatform@gmail.com').trim();
  if (primaryRecipient) {
    recipientMap.set(primaryRecipient.toLowerCase(), {
      email: primaryRecipient,
      name: 'Campus Operations Desk',
      role: 'Facility Administrator',
      alerts: [...batch],
    });
  }

  for (const sub of subscribers) {
    const matched = batch.filter(a => doesAlertMatchSubscriber(a, sub));
    if (matched.length > 0) {
      const key = sub.email.trim().toLowerCase();
      if (recipientMap.has(key)) {
        // Merge alerts without duplicates
        const existing = recipientMap.get(key);
        const existingIds = new Set(existing.alerts.map(a => a.id));
        matched.forEach(a => { if (!existingIds.has(a.id)) existing.alerts.push(a); });
      } else {
        recipientMap.set(key, {
          email: sub.email.trim(),
          name: sub.name || 'Operations Officer',
          role: sub.role || 'Facility Engineer',
          alerts: matched,
        });
      }
    }
  }

  const results = await Promise.all(
    Array.from(recipientMap.values()).map(async (target) => {
      const list = target.alerts;
      let emailPayload;
      if (list.length === 1) {
        const formatted = formatEmail(list[0]);
        emailPayload = {
          to: target.email,
          recipientName: target.name,
          recipientRole: target.role,
          subject: formatted.subject,
          html: formatted.html,
          text: formatted.body,
          alertCount: 1,
          sensorIds: [list[0].deviceId],
        };
      } else {
        const formatted = formatMultiSensorBatchEmail(list, org);
        emailPayload = {
          to: target.email,
          recipientName: target.name,
          recipientRole: target.role,
          subject: formatted.subject,
          html: formatted.html,
          text: formatted.text,
          alertCount: list.length,
          sensorIds: list.map(a => a.deviceId),
        };
      }
      const res = await dispatchEmailNotification(emailPayload);

      // Sync email log to Central Backend (MongoDB NotificationLog) for Dashboard visibility
      if (process.env.NODE_ENV !== 'test') {
        const backendBase = (process.env.CENTRAL_BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
        const targetOrgId = org?.id === 'hospital' ? 'city_hospital' : 'bput_college';
        fetch(`${backendBase}/api/actions/log-simulator-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId: targetOrgId,
            deviceId: list.map(a => a.deviceId).join(', '),
            source: 'simulator-batch',
            subscriberEmail: target.email,
            subscriberName: target.name,
            subscriberRole: target.role,
            topicName: list.length > 1 ? `Multi-Sensor Batch (${list.length} Sensors)` : (list[0].category || 'SCADA Alert'),
            alertTitle: emailPayload.subject,
            alertType: list[0].kind === 'water_tank' ? 'water_leak' : (list[0].kind === 'waste_bin' || list[0].kind === 'waste_compactor' ? 'waste' : 'power'),
            alertSeverity: list.some(a => a.severity === 'CRITICAL') ? 'critical' : 'warning',
            subject: emailPayload.subject,
            bodyPreview: `${list.length} sensor(s): ${list.map(a => `${a.deviceLabel} (${a.currentValue}${a.unit || ''})`).join(', ')}`,
            status: res.status === 'sent' ? 'sent' : (res.status === 'failed' ? 'failed' : 'sent'),
            errorMessage: res.error || '',
          }),
        }).catch(() => {});
      }

      return res;
    })
  );

  const primaryResult = results[0] || null;
  alertEmitter.emit('alert_batch_email', {
    result: primaryResult,
    results,
    recipients: Array.from(recipientMap.values()).map(t => t.email),
    batchCount: batch.length,
    alertIds: batch.map(a => a.id),
    timestamp: new Date().toISOString(),
  });
  return primaryResult;
}

// ── Envelope Breach Duration Tracker ──────────────────────────────────────────

/**
 * Maps dedupeKey -> { firstBreachedAt: number, lastSeenAt: number, ticks: number, deviceId: string, deviceLabel: string, metric: string, currentValue: number, threshold: string }
 */
const breachTracker = new Map();
const DEFAULT_BREACH_DURATION_MS = process.env.NODE_ENV === 'test'
  ? 0
  : (parseInt(process.env.ALERT_ENVELOPE_DURATION_MS, 10) || 6000);

/**
 * Check if a metric breaches its envelope and satisfies the duration requirement before promoting to an alert.
 * @param {string} dedupeKey
 * @param {boolean} isBreaching
 * @param {Object} alertData
 * @param {number} requiredDurationMs
 * @param {string} resolveReason
 */
function checkEnvelopeBreach(dedupeKey, isBreaching, alertData, requiredDurationMs = DEFAULT_BREACH_DURATION_MS, resolveReason = 'Metric returned to nominal envelope.') {
  if (isBreaching) {
    let rec = breachTracker.get(dedupeKey);
    const now = Date.now();
    if (!rec) {
      rec = {
        dedupeKey,
        deviceId: alertData.deviceId,
        deviceLabel: alertData.deviceLabel,
        metric: alertData.metric,
        ruleCode: alertData.ruleCode,
        currentValue: alertData.currentValue,
        threshold: alertData.threshold,
        unit: alertData.unit || '',
        firstBreachedAt: now,
        lastSeenAt: now,
        ticks: 1,
        requiredMs: requiredDurationMs,
        promoted: false,
      };
      breachTracker.set(dedupeKey, rec);
    } else {
      rec.ticks += 1;
      rec.lastSeenAt = now;
      rec.currentValue = alertData.currentValue;
    }

    const elapsedMs = now - rec.firstBreachedAt;
    if (requiredDurationMs <= 0 || elapsedMs >= requiredDurationMs) {
      rec.promoted = true;
      raiseAlert({
        ...alertData,
        dedupeKey,
        breachDurationSec: Math.max(1, Math.round(elapsedMs / 1000)),
      });
    }
  } else {
    if (breachTracker.has(dedupeKey)) {
      breachTracker.delete(dedupeKey);
    }
    autoResolveByKey(dedupeKey, resolveReason);
  }
}

function getActiveBreaches() {
  const now = Date.now();
  return Array.from(breachTracker.values()).map(b => ({
    ...b,
    elapsedMs: now - b.firstBreachedAt,
    progressPct: b.requiredMs > 0 ? Math.min(100, Math.round(((now - b.firstBreachedAt) / b.requiredMs) * 100)) : 100,
  }));
}

function resetTransientState() {
  breachTracker.clear();
  pendingEmailBatch.clear();
  if (batchEmailTimer) {
    clearTimeout(batchEmailTimer);
    batchEmailTimer = null;
  }
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
  const dedupeKey = alertData.dedupeKey || `${alertData.deviceId}_${alertData.metric}_${alertData.ruleCode}`;
  const now = new Date();

  // If already active or acknowledged, update in place
  if (activeDedupeMap.has(dedupeKey)) {
    const existingId = activeDedupeMap.get(dedupeKey);
    const existing = alerts.get(existingId);
    if (existing && (existing.status === 'active' || existing.status === 'acknowledged')) {
      existing.currentValue = alertData.currentValue;
      existing.updatedAt = now.toISOString();
      existing.tickOccurrences = (existing.tickOccurrences || 1) + 1;
      if (alertData.breachDurationSec) existing.breachDurationSec = alertData.breachDurationSec;
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
    aliasId: SENSOR_ALIASES[alertData.deviceId] || alertData.deviceId,
    breachDurationSec: alertData.breachDurationSec || null,
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

  // Queue for batch consolidated email dispatch
  queueAlertForBatchEmail(newAlert);

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
      const isBlackout = faultTypes.includes('blackout') || (voltage !== undefined && voltage < 10 && kw === 0);

      // 1A. Voltage Sag Check (sustained duration unless severe brownout < 185V)
      const sagDedupe = `${devId}_voltage_sag`;
      const isSag = !isBlackout && voltage !== undefined && voltage < rules.voltage.min && voltage > 10;
      const isCriticalSag = org.id === 'hospital' || (voltage !== undefined && voltage < 195);
      checkEnvelopeBreach(
        sagDedupe,
        isSag,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Electrical Quality',
          metric: 'voltage',
          ruleCode: 'voltage_sag',
          currentValue: parseFloat((voltage || 0).toFixed(1)),
          threshold: `< ${rules.voltage.min} V`,
          unit: 'V',
          severity: isCriticalSag ? 'CRITICAL' : 'HIGH',
          title: `⚠️ Voltage Sag on ${label} (${(voltage || 0).toFixed(1)} V)`,
          regulatoryReference: `CEA Grid Standards & BIS IS 12360 (Min ${rules.voltage.min} V)`,
          financialImpact: 'High risk of motor stall, coil burnout, and IT power supply tripping.',
          actionablePlaybook: `Check LT panel On-Load Tap Changer (OLTC). Inspect main phase busbar voltage. If on backup DG, adjust AVR (Automatic Voltage Regulator).`,
          escalationRole: org.persona.groundTeam,
        },
        (voltage !== undefined && voltage < 185) ? 0 : DEFAULT_BREACH_DURATION_MS,
        'Voltage normalized within CEA standard limits.'
      );

      // 1B. Voltage Spike Check (sustained duration unless catastrophic > 265V)
      const spikeDedupe = `${devId}_voltage_spike`;
      const isSpike = voltage !== undefined && voltage > rules.voltage.max;
      const isCriticalSpike = (voltage !== undefined && voltage > 255) || org.id === 'hospital';
      checkEnvelopeBreach(
        spikeDedupe,
        isSpike,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Electrical Quality',
          metric: 'voltage',
          ruleCode: 'voltage_spike',
          currentValue: parseFloat((voltage || 0).toFixed(1)),
          threshold: `> ${rules.voltage.max} V`,
          unit: 'V',
          severity: isCriticalSpike ? 'CRITICAL' : 'HIGH',
          title: `⚡ Overvoltage Spike on ${label} (${(voltage || 0).toFixed(1)} V)`,
          regulatoryReference: `CEA Grid Standards (Max ${rules.voltage.max} V)`,
          financialImpact: 'Dielectric breakdown hazard; catastrophic failure of sensitive SMPS power supplies.',
          actionablePlaybook: `Isolate surge protection device (SPD) failure. Step down transformer tap switch immediately.`,
          escalationRole: org.persona.groundTeam,
        },
        (voltage !== undefined && voltage > 265) ? 0 : DEFAULT_BREACH_DURATION_MS,
        'Voltage returned to safe nominal CEA operating limits.'
      );

      // 1C. Blackout / Feeder Loss
      const blackoutDedupe = `${devId}_power_blackout`;
      if (isBlackout) {
        raiseAlert({
          dedupeKey: blackoutDedupe,
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

      // 1D. DISCOM Power Factor Penalty Alert (baseline-aware floor + sustained duration; skipped during blackout)
      const pfDedupe = `${devId}_power_factor_drop`;
      const deviceBasePf = r._baseline?.power_factor;
      const minPf = deviceBasePf
        ? parseFloat(Math.min(rules.power_factor.min, deviceBasePf - 0.035).toFixed(3))
        : rules.power_factor.min;
      const isBadPf = !isBlackout && !faultTypes.includes('sensor_offline') && pf !== undefined && pf < minPf;
      const pfEval = isBadPf ? calculatePFPenalty(pf, 50000, baseRate) : { explanation: '', monthlyAmountINR: 0 };
      const isSeverePf = isBadPf && (pf < 0.80 || org.id === 'industrial_powerhouse');
      checkEnvelopeBreach(
        pfDedupe,
        isBadPf,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'DISCOM Compliance',
          metric: 'power_factor',
          ruleCode: 'power_factor_drop',
          currentValue: parseFloat((pf || 0).toFixed(3)),
          threshold: `< ${minPf}`,
          unit: 'PF',
          severity: isSeverePf ? 'HIGH' : 'MEDIUM',
          title: `📉 DISCOM Power Factor Surcharge Alert (${label}: ${(pf || 0).toFixed(2)})`,
          regulatoryReference: `State Electricity Regulatory Commission (SERC) HT Tariff Regulations`,
          financialImpact: `${pfEval.explanation} Approx. ${formatINR(pfEval.monthlyAmountINR)}/month surcharge.`,
          estimatedLossPerHour: formatINR(Math.round(pfEval.monthlyAmountINR / 720)),
          actionablePlaybook: `Dispatch ${org.persona.groundTeam} to check APFC (Automatic Power Factor Correction) bank. Replace blown capacitor steps and contactors.`,
          escalationRole: org.persona.groundTeam,
        },
        DEFAULT_BREACH_DURATION_MS,
        'Power Factor compliant with DISCOM benchmark.'
      );

      // 1E. Feeder Overload / Maximum Demand (dynamic per-feeder upper envelope + sustained duration)
      const overloadDedupe = `${devId}_power_kw_overload`;
      const deviceBaseKw = r._baseline?.power_kw;
      const upperEnvelopeKw = deviceBaseKw
        ? parseFloat(Math.max(rules.feeder_kw_overload * 0.4, deviceBaseKw * 1.22).toFixed(1))
        : rules.feeder_kw_overload;
      const isOverload = !isBlackout && kw !== undefined && kw > upperEnvelopeKw;
      const isHigh = isOverload && kw > upperEnvelopeKw * 1.25;
      checkEnvelopeBreach(
        overloadDedupe,
        isOverload,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Demand Management',
          metric: 'power_kw',
          ruleCode: 'power_kw_overload',
          currentValue: parseFloat((kw || 0).toFixed(1)),
          threshold: `> ${upperEnvelopeKw} kW`,
          unit: 'kW',
          severity: isHigh ? 'CRITICAL' : 'HIGH',
          title: `🔥 Feeder Overload on ${label} (${(kw || 0).toFixed(1)} kW > ${upperEnvelopeKw} kW)`,
          regulatoryReference: `Contracted Maximum Demand (CMD) Tariff Threshold`,
          financialImpact: `Contributes ${formatINR(Math.round((kw || 0) * effectiveRate))}/hr. Incurs 150% penalty if campus exceeds CMD.`,
          actionablePlaybook: `Stagger heavy equipment duty cycles (chillers, compressors, pumping sets). Verify phase current balance across R-Y-B phases.`,
          escalationRole: org.persona.groundTeam,
        },
        DEFAULT_BREACH_DURATION_MS,
        'Feeder load within rated continuous capacity.'
      );

      // 1F. Frequency Drift (skipped during blackout; sustained duration check)
      const freqDedupe = `${devId}_frequency_drift`;
      const isBadFreq = !isBlackout && freq !== undefined && (freq < rules.frequency.min || freq > rules.frequency.max);
      checkEnvelopeBreach(
        freqDedupe,
        isBadFreq,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Grid Quality',
          metric: 'frequency',
          ruleCode: 'frequency_drift',
          currentValue: parseFloat((freq || 0).toFixed(3)),
          threshold: `${rules.frequency.min} - ${rules.frequency.max} Hz`,
          unit: 'Hz',
          severity: 'HIGH',
          title: `⚡ Grid Frequency Drift on ${label} (${(freq || 0).toFixed(2)} Hz)`,
          regulatoryReference: `Indian Electricity Grid Code (IEGC Section 5.2)`,
          financialImpact: 'Threatens motor speed synchronism, clock accuracy, and turbine stability.',
          actionablePlaybook: `Notify state SLDC / DISCOM grid control room. If islanded on captive DG, adjust generator governor speed governor.`,
          escalationRole: org.persona.groundTeam,
        },
        DEFAULT_BREACH_DURATION_MS,
        'Grid frequency stabilized within IEGC statutory limits.'
      );
    }

    // ── 2. Hydraulic Subsystem Checks (Water Tanks) ─────────────────────────
    if (kind === 'water_tank') {
      const lpm = v.flow_lpm || 0;
      const bar = v.pressure_bar;
      const level = v.tank_level_percent;
      const hasLeakFlag = v.leak_detected || faultTypes.includes('leak') || faultTypes.includes('burst');

      // 2A. Pipe Burst / Uncontrolled Water Leak (dynamic envelope + sustained duration for non-burst leaks)
      const leakDedupe = `${devId}_water_leak`;
      const baseFlow = r._baseline?.flow_lpm;
      const upperFlowEnvelope = baseFlow
        ? parseFloat(Math.max(rules.water_flow_leak_lpm, baseFlow * 1.25).toFixed(1))
        : rules.water_flow_leak_lpm;
      const isBurst = faultTypes.includes('burst') || lpm > Math.max(60, upperFlowEnvelope * 2.2);
      const isSignificantLeak = hasLeakFlag || lpm > upperFlowEnvelope;

      const hourlyLoss = Math.round(lpm * 60);
      const hourlyCostINR = Math.round(hourlyLoss * tankerCostPerLitre);
      const tankersPerHour = (hourlyLoss / 6000).toFixed(2);

      checkEnvelopeBreach(
        leakDedupe,
        isSignificantLeak,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Conservation',
          metric: 'flow_lpm',
          ruleCode: 'water_leak',
          currentValue: parseFloat(lpm.toFixed(1)),
          threshold: `> ${upperFlowEnvelope} LPM`,
          unit: 'LPM',
          severity: isBurst ? 'CRITICAL' : 'HIGH',
          title: `${isBurst ? '💥 CATASTROPHIC PIPE BURST' : '💧 Active Water Leak'} on ${label} (${lpm.toFixed(1)} LPM)`,
          regulatoryReference: `CPHEEO Water Loss Reduction Norm & NBC 2016`,
          financialImpact: `Wasting ~${hourlyLoss.toLocaleString('en-IN')} L/hr (~${formatINR(hourlyCostINR)}/hr in private tanker replacement, ~${tankersPerHour} tankers/hr).`,
          estimatedLossPerHour: formatINR(hourlyCostINR),
          actionablePlaybook: `Dispatch ${org.persona.groundTeam} immediately to isolate sector valve upstream of ${devId}. Shut down booster transfer pump.`,
          escalationRole: org.persona.groundTeam,
        },
        isBurst ? 0 : DEFAULT_BREACH_DURATION_MS,
        'Water flow rate normal; leak isolated.'
      );

      // 2B. Low Supply Pressure (baseline-aware threshold + sustained breach gate)
      const pressDedupe = `${devId}_low_pressure`;
      const deviceBasePress = r._baseline?.pressure_bar;
      const minPress = deviceBasePress
        ? parseFloat(Math.min(rules.water_pressure.min, deviceBasePress * 0.80).toFixed(2))
        : rules.water_pressure.min;
      const isLowPress = !faultTypes.includes('sensor_offline') && bar !== undefined && bar < minPress;
      const isCriticalPress = org.id === 'hospital' || (bar !== undefined && bar < 1.0);
      checkEnvelopeBreach(
        pressDedupe,
        isLowPress,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Hydraulic Quality',
          metric: 'pressure_bar',
          ruleCode: 'low_pressure',
          currentValue: parseFloat((bar || 0).toFixed(2)),
          threshold: `< ${minPress} bar`,
          unit: 'bar',
          severity: isCriticalPress ? 'CRITICAL' : 'MEDIUM',
          title: `📉 Low Hydraulic Pressure on ${label} (${(bar || 0).toFixed(2)} bar)`,
          regulatoryReference: `CPHEEO Manual on Water Supply (Minimum tap terminal pressure: ${minPress} bar)`,
          financialImpact: org.id === 'hospital' ? 'CRITICAL: Inadequate water pressure for Dialysis RO plants & fire safety hydrants.' : 'Loss of upper floor gravity feed.',
          actionablePlaybook: `Inspect hydropneumatic booster pump sets. Check for line airlocks and suction filter clogging.`,
          escalationRole: org.persona.groundTeam,
        },
        (bar !== undefined && bar < 1.0) ? 0 : DEFAULT_BREACH_DURATION_MS,
        'Hydraulic pressure restored to CPHEEO standards.'
      );

      // 2B-2. Pump Power / Pressure Degradation (Virtual Ultrasonic Profiling)
      const pumpDegradeDedupe = `${devId}_pump_power_degraded`;
      if (v.virtual_pump_sensor?.pump_pressure_status === 'DEGRADED_PRESSURE' && v.virtual_pump_sensor.inferred_pump_active) {
        raiseAlert({
          dedupeKey: pumpDegradeDedupe,
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
          dedupeKey: immedOverflowDedupe,
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
          dedupeKey: overflowDedupe,
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
          dedupeKey: rapidDrainDedupe,
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
          dedupeKey: dryDedupe,
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

    // ── 3. Solid Waste & Compactor Subsystem Checks ─────────────────────────
    if (kind === 'waste_bin' || kind === 'waste_compactor') {
      const fill = v.fill_level_percent || 0;
      const weight = v.weight_kg || 0;
      const odor = v.odor_index_ppm || 0;
      const temp = v.temperature_c || 25;
      const isCompactorJammed = v.compactor_status === 'JAMMED' || faultTypes.includes('compactor_jam');
      const isOverflowing = fill > 90 || v.bin_status === 'OVERFLOWING' || faultTypes.includes('bin_overflow');
      const isFireHazard = temp > 65 || faultTypes.includes('fire_hazard_heat');
      const isOdorHazard = odor > 80 || faultTypes.includes('methane_odor_spike');

      // 3A. Waste Receptacle Overflow (sustained envelope duration gate)
      const overflowDedupe = `${devId}_waste_overflow`;
      checkEnvelopeBreach(
        overflowDedupe,
        isOverflowing,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Sanitation & Hygiene',
          metric: 'fill_level_percent',
          ruleCode: 'waste_overflow',
          currentValue: fill,
          threshold: '> 90%',
          unit: '%',
          severity: 'HIGH',
          title: `🗑️ Waste Overflow on ${label} (${fill}% Full, ${weight} kg)`,
          regulatoryReference: 'Solid Waste Management Rules 2016 (MoEFCC & SBM Urban 2.0)',
          financialImpact: 'Swachh Survekshan sanitation de-rating penalty and litter cleanup costs.',
          actionablePlaybook: 'Dispatch sanitation crew to empty receptacle and route to campus compost yard or municipal transfer station.',
          escalationRole: 'Sanitation Supervisor',
        },
        DEFAULT_BREACH_DURATION_MS,
        'Waste container emptied and restored to safe fill capacity.'
      );

      // 3B. Hydraulic Compactor Jam (sustained envelope check)
      const jamDedupe = `${devId}_compactor_jam`;
      checkEnvelopeBreach(
        jamDedupe,
        isCompactorJammed,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Compactor Machinery',
          metric: 'compactor_status',
          ruleCode: 'waste_compactor_jam',
          currentValue: 'JAMMED',
          threshold: 'JAMMED',
          unit: 'status',
          severity: 'HIGH',
          title: `⚙️ Hydraulic Compactor Jammed on ${label}`,
          regulatoryReference: 'Campus Mechanical Safety & Solid Waste Equipment Norms',
          financialImpact: 'Risk of hydraulic pump motor burnout and uncompressed waste overflow.',
          actionablePlaybook: 'Emergency stop hydraulic ram. Clear oversized debris obstruction before resetting motor breaker.',
          escalationRole: 'Maintenance Fitter',
        },
        DEFAULT_BREACH_DURATION_MS,
        'Compactor ram cleared and operating smoothly.'
      );

      // 3C. Thermal / Fire Hazard in Waste Bin
      const fireDedupe = `${devId}_waste_fire_hazard`;
      if (isFireHazard) {
        raiseAlert({
          dedupeKey: fireDedupe,
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Fire & Life Safety',
          metric: 'temperature_c',
          ruleCode: 'waste_fire_hazard',
          currentValue: temp,
          threshold: '> 65°C',
          unit: '°C',
          severity: 'CRITICAL',
          title: `🔥 Smoldering Waste Fire Hazard on ${label} (${temp}°C)`,
          regulatoryReference: 'National Building Code (NBC 2016 Part 4 - Fire & Life Safety)',
          financialImpact: 'Structural smoke damage and campus emergency muster trigger.',
          actionablePlaybook: 'Deploy dry chemical extinguisher immediately. Isolate flammable waste bin from adjacent walls.',
          escalationRole: 'Campus Fire Marshall & Security',
        });
      } else if (temp < 45) {
        autoResolveByKey(fireDedupe, 'Waste receptacle temperature cooled to ambient normal.');
      }

      // 3D. Odor / Methane Hazard (sustained envelope duration gate)
      const odorDedupe = `${devId}_waste_odor_hazard`;
      checkEnvelopeBreach(
        odorDedupe,
        isOdorHazard,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Air Quality & Biohazard',
          metric: 'odor_index_ppm',
          ruleCode: 'waste_odor_hazard',
          currentValue: odor,
          threshold: '> 80 ppm',
          unit: 'ppm',
          severity: 'MEDIUM',
          title: `☣️ High Methane / Odor Level on ${label} (${odor} ppm)`,
          regulatoryReference: 'CPCB Guidelines on Municipal Solid Waste Aeration',
          financialImpact: 'Unpleasant working conditions and pest breeding hazard.',
          actionablePlaybook: 'Ventilate organic storage vault, apply microbial bio-sanitizer spray, and accelerate compost rotation.',
          escalationRole: 'Sanitation Team Lead',
        },
        DEFAULT_BREACH_DURATION_MS,
        'Odor and methane concentration dissipated.'
      );
    }

    // ── 4. Cyber-Physical Attacks & Device Tampering Checks ─────────────────
    const attackDedupe = `${devId}_cyber_security`;
    const cyberThreats = faultTypes.filter(t =>
      ['spoofed_sensor', 'replay_attack', 'out_of_range', 'value_injection', 'duplicate_flood', 'clock_skew', 'missing_heartbeat'].includes(t)
    );

    if (cyberThreats.length > 0) {
      const threatName = cyberThreats.join(', ');
      raiseAlert({
        dedupeKey: attackDedupe,
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

    // ── 5. Sensor Hardware & Signal Integrity Checks ────────────────────────
    const hwDedupe = `${devId}_sensor_integrity`;
    const hwFaults = faultTypes.filter(t => ['noisy', 'stuck_value', 'drift', 'sensor_offline'].includes(t));
    if (hwFaults.length > 0) {
      const hwName = hwFaults.join(', ');
      checkEnvelopeBreach(
        hwDedupe,
        true,
        {
          deviceId: devId,
          deviceLabel: label,
          kind,
          category: 'Sensor Diagnostics',
          metric: 'signal_quality',
          ruleCode: 'sensor_integrity',
          currentValue: hwName,
          threshold: 'Signal Variance & Calibration Limits',
          unit: '',
          severity: hwFaults.includes('sensor_offline') ? 'HIGH' : 'MEDIUM',
          title: `📡 Sensor Anomaly on ${label} (${hwName})`,
          regulatoryReference: 'ISO/IEC 30141 IoT Sensor Reliability Benchmark',
          financialImpact: 'Degraded telemetry observability across smart building controls.',
          actionablePlaybook: `Inspect Modbus/RS-485 fieldbus shielding and recalibrate transducer at ${devId}.`,
          escalationRole: org.persona.groundTeam,
        },
        hwFaults.includes('sensor_offline') ? 0 : DEFAULT_BREACH_DURATION_MS,
        'Sensor signal variance and calibration stabilized.'
      );
    } else {
      checkEnvelopeBreach(hwDedupe, false, { deviceId: devId }, DEFAULT_BREACH_DURATION_MS, 'Sensor signal variance and calibration stabilized.');
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
  getEmailLogs: () => emailDispatchLogs,
  getActiveBreaches,
  resetTransientState,
  flushAlertBatchEmail,
  dispatchEmailNotification,
  SENSOR_ALIASES,
  PROFILE_THRESHOLDS,
};
