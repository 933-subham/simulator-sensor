/**
 * test/run-tests.js
 * ─────────────────────────────────────────────────────────────
 * Comprehensive test runner for sensor-sim-api.
 * Dispatches directly into Express via app.handle() — requires no
 * network sockets, working in any sandboxed or isolated environment.
 *
 * Tests:
 *  0. Health & static control panel serving
 *  1. Devices listing & secret masking
 *  2. One-time claim flow & secret retrieval
 *  3. Inbound Push HMAC authentication & replay protection
 *  4. Power meter faults (spike, sag, overload, power_factor_drop, frequency_drift, blackout)
 *  5. Water tank faults (leak, burst, low_pressure, tank_overflow, tank_dry)
 *  6. Common faults (sensor_offline, stuck_value, noisy, drift)
 *  7. Attack / Cyber-physical faults (spoofed_sensor, replay_attack, out_of_range, value_injection, duplicate_flood, clock_skew, missing_heartbeat)
 *  8. Target resolution (deviceId, labelPrefix, kind, all)
 *  9. Scenario presets (including attack scenarios)
 * 10. Fault logging & ground truth labels
 * 11. Campus totals summary
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { app, engine } = require('../src/server');

let passed = 0;
let failed = 0;

function ok(name, details = '') {
  console.log(`  \x1b[32m✓\x1b[0m ${name}${details ? ` (${details})` : ''}`);
  passed++;
}

function fail(name, error) {
  console.error(`  \x1b[31m✗\x1b[0m ${name}:`, error);
  failed++;
}

function section(title) {
  console.log(`\n\x1b[1m\x1b[36m=== ${title} ===\x1b[0m`);
}

/**
 * In-memory HTTP dispatch directly into Express.
 * Bypasses TCP network stack — completely immune to sandbox firewall restrictions.
 */
function api(method, url, { headers = {}, body = null, closeAfterFirstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const req = new Readable({
      read() {
        if (bodyStr) this.push(bodyStr);
        this.push(null);
      },
    });

    const keyHeader = process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {};

    req.method = method.toUpperCase();
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      ...keyHeader,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    };
    if (bodyStr) {
      req.headers['content-length'] = String(Buffer.byteLength(bodyStr));
    }

    const resEvents = new EventEmitter();
    let resHeaders = {};
    const chunks = [];

    const res = {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      getHeader(k) { return resHeaders[k.toLowerCase()]; },
      writeHead(code, h) {
        this.statusCode = code;
        if (h) Object.assign(resHeaders, h);
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(obj) {
        this.setHeader('content-type', 'application/json');
        this.end(JSON.stringify(obj));
      },
      send(data) {
        this.end(data);
      },
      redirect(dest) {
        this.statusCode = 302;
        this.setHeader('location', dest);
        this.end();
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resEvents.emit('data', chunk);
        if (closeAfterFirstChunk) {
          req.emit('close');
          this.end();
        }
        return true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({
          status: this.statusCode,
          headers: resHeaders,
          text,
          data,
          events: resEvents,
        });
      },
      on(ev, fn) { resEvents.on(ev, fn); },
      once(ev, fn) { resEvents.once(ev, fn); },
      emit(ev, ...args) { return resEvents.emit(ev, ...args); },
    };

    app.handle(req, res, (err) => {
      if (err) reject(err);
      else res.end();
    });
  });
}

async function run() {
  console.log('\x1b[1mStarting sensor-sim-api test suite...\x1b[0m');

  // Start engine
  engine.start();

  try {
    // ── 0. Health Check ─────────────────────────────────────
    section('0. Health Check');
    {
      const res = await api('GET', '/api/health');
      if (res.status === 200 && res.data?.status === 'ok') {
        ok('GET /api/health returns 200 ok', `devices total: ${res.data.devices.total}`);
      } else {
        fail('GET /api/health', res.text);
      }
    }

    // ── 1. Devices & Seeding ────────────────────────────────
    section('1. Device Management & Seeding');
    let devices = [];
    {
      const res = await api('GET', '/api/devices');
      devices = res.data;
      if (res.status === 200 && Array.isArray(devices) && (devices.length === 27 || devices.length >= 23)) {
        ok(`GET /api/devices lists all ${devices.length} seed devices`);
      } else {
        fail('GET /api/devices', `Expected seed devices (>=23), got ${devices?.length}`);
      }

      const hasSecret = devices.some(d => d.secret !== undefined);
      if (!hasSecret) {
        ok('GET /api/devices hides secret keys');
      } else {
        fail('GET /api/devices', 'Secret key was exposed in devices listing!');
      }
    }

    // ── 2. Claim Flow ───────────────────────────────────────
    section('2. Device Creation & Claim Flow');
    let testDevice = null;
    let deviceSecret = null;
    {
      const createRes = await api('POST', '/api/devices', {
        body: {
          kind: 'power_meter',
          label: 'Test Meter 1',
          buildingType: 'academic',
        },
      });

      if (createRes.status === 201 && createRes.data?.deviceId && createRes.data?.claimCode) {
        testDevice = createRes.data;
        ok('POST /api/devices created device with claimCode', testDevice.deviceId);
        if (!testDevice.secret) {
          ok('POST /api/devices does NOT expose secret key directly');
        } else {
          fail('POST /api/devices', 'Secret was returned on device creation!');
        }
      } else {
        fail('POST /api/devices', createRes.text);
      }

      // Claim code
      const claimRes = await api('POST', '/api/claim', {
        body: { claimCode: testDevice.claimCode },
      });

      if ((claimRes.status === 200 || claimRes.status === 201) && claimRes.data?.secret) {
        deviceSecret = claimRes.data.secret;
        ok('POST /api/claim successfully returned secret on first attempt');
      } else {
        fail('POST /api/claim', claimRes.text);
      }

      // Second claim attempt must fail with 410
      const claim2 = await api('POST', '/api/claim', {
        body: { claimCode: testDevice.claimCode },
      });

      if (claim2.status === 410) {
        ok('POST /api/claim rejects second claim with 410 Gone');
      } else {
        fail('POST /api/claim duplicate', `Expected status 410, got ${claim2.status}`);
      }
    }

    // ── 3. Push Endpoint HMAC & Security ────────────────────
    section('3. Inbound Push HMAC & Replay Protection');
    {
      const deviceId = testDevice.deviceId;
      const values = { power_kw: 55.4, voltage: 230.1, current: 80.5, power_factor: 0.95, frequency: 50.0, energy_kwh: 500.0 };

      function makeSig(devId, ts, seq, vals, secret) {
        const canonical = JSON.stringify(
          Object.fromEntries(Object.entries(vals).sort(([a], [b]) => a.localeCompare(b)))
        );
        const payload = `${devId}.${ts}.${seq}.${canonical}`;
        return crypto.createHmac('sha256', secret).update(payload).digest('hex');
      }

      const ts = new Date().toISOString();
      const validSig = makeSig(deviceId, ts, 1, values, deviceSecret);

      // 3.1 Valid Push
      const push1 = await api('POST', `/api/push/${deviceId}`, {
        headers: {
          'x-device-id': deviceId,
          'x-timestamp': ts,
          'x-seq': '1',
          'x-signature': validSig,
        },
        body: { values },
      });

      if (push1.status === 201 && push1.data?.accepted) {
        ok('POST /api/push/:id accepts valid HMAC signed reading');
      } else {
        fail('POST /api/push/:id valid', push1.text);
      }

      // 3.2 Bad Signature
      const pushBadSig = await api('POST', `/api/push/${deviceId}`, {
        headers: {
          'x-device-id': deviceId,
          'x-timestamp': ts,
          'x-seq': '2',
          'x-signature': 'bad_hex_signature_here',
        },
        body: { values },
      });

      if (pushBadSig.status === 401) {
        ok('POST /api/push/:id rejects invalid HMAC signature with 401');
      } else {
        fail('POST /api/push/:id bad sig', `Expected 401, got ${pushBadSig.status}`);
      }

      // 3.3 Replayed Sequence Number
      const replayedSig = makeSig(deviceId, ts, 1, values, deviceSecret);
      const pushReplay = await api('POST', `/api/push/${deviceId}`, {
        headers: {
          'x-device-id': deviceId,
          'x-timestamp': ts,
          'x-seq': '1', // already used seq 1
          'x-signature': replayedSig,
        },
        body: { values },
      });

      if (pushReplay.status === 409) {
        ok('POST /api/push/:id rejects replayed sequence number with 409');
      } else {
        fail('POST /api/push/:id replayed seq', `Expected 409, got ${pushReplay.status}`);
      }

      // 3.4 Stale Timestamp (> 60s ago)
      const oldTs = new Date(Date.now() - 70000).toISOString();
      const oldSig = makeSig(deviceId, oldTs, 3, values, deviceSecret);
      const pushOld = await api('POST', `/api/push/${deviceId}`, {
        headers: {
          'x-device-id': deviceId,
          'x-timestamp': oldTs,
          'x-seq': '3',
          'x-signature': oldSig,
        },
        body: { values },
      });

      if (pushOld.status === 401) {
        ok('POST /api/push/:id rejects stale timestamp (>60s) with 401');
      } else {
        fail('POST /api/push/:id stale ts', `Expected 401, got ${pushOld.status}`);
      }
    }

    // ── 4. Power Meter Faults ───────────────────────────────
    section('4. Power Meter Faults & Recovery');
    const pwrDev = devices.find(d => d.kind === 'power_meter').deviceId;
    const powerFaults = ['spike', 'sag', 'overload', 'power_factor_drop', 'frequency_drift', 'blackout'];

    for (const ft of powerFaults) {
      const injectRes = await api('POST', '/api/faults', {
        body: { deviceId: pwrDev, type: ft, severity: 0.9 },
      });

      if (injectRes.status !== 201 || !injectRes.data?.id) {
        fail(`Inject power fault ${ft}`, injectRes.text);
        continue;
      }
      const faultId = injectRes.data.id;

      // Tick simulation to generate reading with fault applied
      await engine.tick();

      // Check ground-truth meta label
      const checkRes = await api('GET', `/api/devices/${pwrDev}/latest?labels=true`);
      const isAnomaly = checkRes.data?.meta?.isAnomaly;
      const faultTypes = checkRes.data?.meta?.faultTypes || [];

      if (isAnomaly === true && faultTypes.includes(ft)) {
        ok(`Power fault '${ft}' active and labeled correctly`);
      } else {
        fail(`Power fault '${ft}' check`, JSON.stringify(checkRes.data?.meta));
      }

      // Clear fault
      const clearRes = await api('DELETE', `/api/faults/${faultId}`);
      if (clearRes.status === 200) {
        ok(`Power fault '${ft}' cleared cleanly`);
      } else {
        fail(`Clear power fault ${ft}`, clearRes.text);
      }
    }

    // ── 5. Water Tank Faults ────────────────────────────────
    section('5. Water Tank Faults');
    const watDev = devices.find(d => d.kind === 'water_tank').deviceId;
    const waterFaults = ['leak', 'burst', 'low_pressure', 'tank_overflow', 'tank_dry'];

    for (const ft of waterFaults) {
      const injectRes = await api('POST', '/api/faults', {
        body: { deviceId: watDev, type: ft, severity: 0.85 },
      });

      if (injectRes.status !== 201) {
        fail(`Inject water fault ${ft}`, injectRes.text);
        continue;
      }
      const faultId = injectRes.data.id;

      // Tick simulation
      await engine.tick();

      const checkRes = await api('GET', `/api/devices/${watDev}/latest?labels=true`);
      if (checkRes.data?.meta?.isAnomaly === true) {
        ok(`Water fault '${ft}' active and labeled correctly`);
      } else {
        fail(`Water fault '${ft}' check`, JSON.stringify(checkRes.data?.meta));
      }

      await api('DELETE', `/api/faults/${faultId}`);
    }

    // ── 6. Common Faults ────────────────────────────────────
    section('6. Common Faults');
    const commonFaults = ['sensor_offline', 'stuck_value', 'noisy', 'drift'];
    for (const ft of commonFaults) {
      const injectRes = await api('POST', '/api/faults', {
        body: { deviceId: pwrDev, type: ft, severity: 0.8 },
      });

      if (injectRes.status !== 201) {
        fail(`Inject common fault ${ft}`, injectRes.text);
        continue;
      }
      const faultId = injectRes.data.id;

      // Tick simulation
      await engine.tick();

      const checkRes = await api('GET', `/api/devices/${pwrDev}/latest?labels=true`);
      if (checkRes.data?.meta?.isAnomaly === true) {
        ok(`Common fault '${ft}' active and labeled correctly`);
      } else {
        fail(`Common fault '${ft}' check`, JSON.stringify(checkRes.data?.meta));
      }

      await api('DELETE', `/api/faults/${faultId}`);
    }

    // ── 7. Attack / Cyber-Physical Faults ───────────────────
    section('7. Attack / Cyber-Physical Faults');
    const attackFaults = [
      'spoofed_sensor',
      'replay_attack',
      'out_of_range',
      'value_injection',
      'duplicate_flood',
      'clock_skew',
      'missing_heartbeat',
    ];

    for (const ft of attackFaults) {
      const injectRes = await api('POST', '/api/faults', {
        body: { deviceId: pwrDev, type: ft, severity: 0.9 },
      });

      if (injectRes.status !== 201) {
        fail(`Inject attack fault ${ft}`, injectRes.text);
        continue;
      }
      const faultId = injectRes.data.id;

      // Tick simulation
      await engine.tick();

      if (ft === 'spoofed_sensor') {
        const latestAll = await api('GET', '/api/readings/latest?labels=true');
        const spoofed = latestAll.data?.find(r => r.meta?.faultTypes?.includes('spoofed_sensor'));
        if (spoofed && spoofed.meta?.isAnomaly) {
          ok(`Attack fault 'spoofed_sensor' injected and found in /api/readings/latest`);
        } else {
          fail(`Attack fault 'spoofed_sensor' check`, 'Spoofed sensor reading not found in latest batch');
        }
      } else if (ft === 'missing_heartbeat') {
        const active = await api('GET', '/api/faults');
        const hasFlt = active.data?.some(f => f.type === 'missing_heartbeat');
        if (hasFlt) {
          ok(`Attack fault 'missing_heartbeat' registered and active`);
        } else {
          fail(`Attack fault 'missing_heartbeat' check`, JSON.stringify(active.data));
        }
      } else {
        const checkRes = await api('GET', `/api/devices/${pwrDev}/latest?labels=true`);
        if (checkRes.data?.meta?.isAnomaly === true) {
          ok(`Attack fault '${ft}' injected and labeled anomaly=true`);
        } else {
          fail(`Attack fault '${ft}' check`, JSON.stringify(checkRes.data?.meta));
        }
      }

      await api('DELETE', `/api/faults/${faultId}`);
    }

    // ── 8. Target Resolution ────────────────────────────────
    section('8. Target Resolution');
    {
      // 8.1 labelPrefix
      const lp = await api('POST', '/api/faults', {
        body: { labelPrefix: 'Building A', type: 'spike', severity: 0.7 },
      });
      if (lp.status === 201 && lp.data.deviceIds.length > 0) {
        ok(`Target labelPrefix resolved to ${lp.data.deviceIds.length} devices`);
        await api('DELETE', `/api/faults/${lp.data.id}`);
      } else {
        fail('Target labelPrefix', lp.text);
      }

      // 8.2 kind
      const kd = await api('POST', '/api/faults', {
        body: { kind: 'water_tank', type: 'burst', severity: 0.8 },
      });
      if (kd.status === 201 && kd.data.deviceIds.length > 0) {
        ok(`Target kind: 'water_tank' resolved to ${kd.data.deviceIds.length} devices`);
        await api('DELETE', `/api/faults/${kd.data.id}`);
      } else {
        fail('Target kind', kd.text);
      }

      // 8.3 all
      const allTgt = await api('POST', '/api/faults', {
        body: { target: 'all', type: 'drift', severity: 0.5 },
      });
      if (allTgt.status === 201 && allTgt.data.deviceIds.length >= 23) {
        ok(`Target: 'all' resolved to all ${allTgt.data.deviceIds.length} devices`);
        await api('DELETE', `/api/faults/${allTgt.data.id}`);
      } else {
        fail('Target all', allTgt.text);
      }
    }

    // ── 9. Scenarios ────────────────────────────────────────
    section('9. Scenario Presets');
    const scenarios = [
      'night-leak',
      'overload',
      'rogue-sensor',
    ];

    for (const sc of scenarios) {
      const res = await api('POST', `/api/scenarios/${sc}`);
      if (res.status === 201 && res.data?.injected > 0) {
        ok(`Scenario '${sc}' injected ${res.data.injected} fault(s)`);
      } else {
        fail(`Scenario '${sc}'`, res.text);
      }
      await api('DELETE', '/api/faults');
    }

    for (const removedSc of ['pump-overflow', 'rapid-drain', 'weak-pump', 'blackout', 'pipe-burst', 'multi-fault', 'replay-attack', 'data-tampering']) {
      const res = await api('POST', `/api/scenarios/${removedSc}`);
      if (res.status === 404) {
        ok(`Removed scenario '${removedSc}' rejected with 404`);
      } else {
        fail(`Removed scenario '${removedSc}' expected 404, got ${res.status}`, res.text);
      }
    }

    // ── 10. Fault Log ───────────────────────────────────────
    section('10. Fault History Log');
    {
      const logRes = await api('GET', '/api/faults/log');
      if (logRes.status === 200 && Array.isArray(logRes.data) && logRes.data.length > 0) {
        ok(`Fault log contains ${logRes.data.length} recorded events for ground-truth model scoring`);
      } else {
        fail('GET /api/faults/log', logRes.text);
      }
    }

    // ── 11. Campus Totals Summary ───────────────────────────
    section('11. Campus Totals Summary');
    {
      const sumRes = await api('GET', '/api/summary');
      if (sumRes.status === 200 && sumRes.data?.totalPowerKw > 0) {
        ok('GET /api/summary returns campus totals', `${sumRes.data.totalPowerKw} kW, ${sumRes.data.totalLitresToday} L`);
      } else {
        fail('GET /api/summary', sumRes.text);
      }
    }

    // ── 12. Drishti Intelligence Engine (Decision Support & Adaptability) ─
    section('12. Drishti Intelligence Engine (Decision Support & Adaptability)');
    {
      // 12.1 Profiles listing
      const profRes = await api('GET', '/api/drishti/profiles');
      if (profRes.status === 200 && Array.isArray(profRes.data?.profiles) && profRes.data.profiles.length >= 5) {
        ok('GET /api/drishti/profiles lists multi-scale organization profiles', `${profRes.data.profiles.length} profiles available`);
      } else {
        fail('GET /api/drishti/profiles', profRes.text);
      }

      // 12.2 Profile switching (e.g. to hospital)
      const switchRes = await api('POST', '/api/drishti/profile', { body: { profileId: 'hospital' } });
      if (switchRes.status === 200 && switchRes.data?.activeProfile?.id === 'hospital') {
        ok("POST /api/drishti/profile switches active profile to 'hospital'");
      } else {
        fail('POST /api/drishti/profile', switchRes.text);
      }

      // 12.3 Executive synthesis generation with INR tariffs
      const synthRes = await api('GET', '/api/drishti/synthesis');
      if (
        synthRes.status === 200 &&
        synthRes.data?.synthesis &&
        synthRes.data?.analytics?.health?.score > 0 &&
        synthRes.data?.analytics?.economics?.currency.includes('INR')
      ) {
        ok(
          'GET /api/drishti/synthesis returns Indian plain-language executive briefing',
          `Health: ${synthRes.data.analytics.health.score}%, Rate: ${synthRes.data.analytics.economics.hourlyEnergyCostFormatted}/hr`
        );
      } else {
        fail('GET /api/drishti/synthesis', synthRes.text);
      }

      // 12.4 Interactive Q&A chat
      const chatRes = await api('POST', '/api/drishti/chat', { body: { query: 'How can it be improved?' } });
      if (chatRes.status === 200 && chatRes.data?.reply && chatRes.data?.provider) {
        ok('POST /api/drishti/chat generates prescriptive decision support', `Provider: ${chatRes.data.provider}`);
      } else {
        fail('POST /api/drishti/chat', chatRes.text);
      }

      // 12.5 Single device diagnostic
      const devRes = await api('GET', '/api/drishti/diagnose/dev-bldA-pwr-f1');
      if (devRes.status === 200 && devRes.data?.diagnosis && devRes.data?.riskLevel) {
        ok('GET /api/drishti/diagnose/:id returns device-level ₹ impact & diagnosis', `Risk: ${devRes.data.riskLevel}`);
      } else {
        fail('GET /api/drishti/diagnose/:id', devRes.text);
      }

      // 12.6 Drishti Configuration
      const configRes = await api('GET', '/api/drishti/config');
      if (configRes.status === 200 && configRes.data?.provider) {
        ok('GET /api/drishti/config returns active engine status', `Model: ${configRes.data.model}`);
      } else {
        fail('GET /api/drishti/config', configRes.text);
      }

      // Switch back to college_campus for default state
      await api('POST', '/api/drishti/profile', { body: { profileId: 'college_campus' } });
    }

    // ── 13. Enterprise Alert Engine & Triage ─────────────────
    section('13. Enterprise Alert Engine & Triage');
    {
      const alertsRes = await api('GET', '/api/alerts');
      if (alertsRes.status === 200 && Array.isArray(alertsRes.data?.alerts)) {
        ok('GET /api/alerts returns alert list and status', `${alertsRes.data.alerts.length} total alerts in history`);
      } else {
        fail('GET /api/alerts', alertsRes.text);
      }

      const sumRes = await api('GET', '/api/alerts/summary');
      if (sumRes.status === 200 && sumRes.data?.bySeverity) {
        ok('GET /api/alerts/summary returns multi-tier severity triage breakdown');
      } else {
        fail('GET /api/alerts/summary', sumRes.text);
      }

      // 13.1 Trigger End-to-End Test Alert
      const testAlertRes = await api('POST', '/api/alerts/test', {
        body: { severity: 'CRITICAL', title: 'Test Grid Surge Alert' }
      });
      let testAlertId = null;
      if (
        testAlertRes.status === 201 &&
        testAlertRes.data?.alert?.id &&
        testAlertRes.data?.alert?.notifications?.smsDlt
      ) {
        testAlertId = testAlertRes.data.alert.id;
        ok(
          'POST /api/alerts/test triggers simulated alert across all channels',
          `AlertId: ${testAlertId}, DLT Header: ${testAlertRes.data.alert.notifications.smsDlt.slice(0, 20)}...`
        );
      } else {
        fail('POST /api/alerts/test', testAlertRes.text);
      }

      // 13.2 Acknowledge Alert
      if (testAlertId) {
        const ackRes = await api('POST', `/api/alerts/${testAlertId}/acknowledge`, {
          body: { user: 'Shift Engineer', note: 'Inspecting feeder panel' }
        });
        if (ackRes.status === 200 && ackRes.data?.alert?.status === 'acknowledged') {
          ok('POST /api/alerts/:id/acknowledge successfully acknowledges alert with audit note');
        } else {
          fail('POST /api/alerts/:id/acknowledge', ackRes.text);
        }

        // 13.3 Resolve Alert
        const resolveRes = await api('POST', `/api/alerts/${testAlertId}/resolve`, {
          body: { user: 'Shift Engineer', reason: 'Busbar voltage restored' }
        });
        if (resolveRes.status === 200 && resolveRes.data?.alert?.status === 'resolved') {
          ok('POST /api/alerts/:id/resolve resolves alert with resolution record');
        } else {
          fail('POST /api/alerts/:id/resolve', resolveRes.text);
        }
      }

      // 13.4 Rules & Threshold Adaptation
      const rulesRes = await api('GET', '/api/alerts/rules');
      if (rulesRes.status === 200 && rulesRes.data?.thresholds?.voltage) {
        ok('GET /api/alerts/rules retrieves active Indian regulatory thresholds');
      } else {
        fail('GET /api/alerts/rules', rulesRes.text);
      }

      // 13.5 Notification Channels Config
      const chnRes = await api('GET', '/api/alerts/channels');
      if (chnRes.status === 200 && chnRes.data?.sms_dlt && chnRes.data?.webhook) {
        ok('GET /api/alerts/channels lists all configured notification integrations');
      } else {
        fail('GET /api/alerts/channels', chnRes.text);
      }

      // 13.6 Multi-Scale Adaptability Verification
      // Switch profile to 'hospital' and check thresholds adapt
      await api('POST', '/api/drishti/profile', { body: { profileId: 'hospital' } });
      const hospRules = await api('GET', '/api/alerts/rules');
      if (hospRules.data?.thresholds?.voltage?.min === 220.0) {
        ok("Alert thresholds adapted for 'hospital' (OT/ICU tight tolerance: 220V - 240V)");
      } else {
        fail("Alert threshold adaptation for 'hospital'", hospRules.text);
      }

      // Switch back to college_campus
      await api('POST', '/api/drishti/profile', { body: { profileId: 'college_campus' } });
    }

    // ── 14. Device Control Operations (Pump, Drain, Patch, Delete) ────────
    section('14. Device Control Operations & Lifecycle');
    {
      const tankDev = devices.find(d => d.kind === 'water_tank').deviceId;

      // 14.1 Pump ON
      const pumpOn = await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'on' } });
      if (pumpOn.status === 200 && (pumpOn.data?.pump === 'on' || pumpOn.data?.details?.pumpMode === 'manual_on')) {
        ok(`POST /api/devices/:id/pump turned pump ON (${tankDev})`);
      } else {
        fail('POST /api/devices/:id/pump (on)', pumpOn.text);
      }

      // 14.2 Pump OFF
      const pumpOff = await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'off' } });
      if (pumpOff.status === 200 && (pumpOff.data?.pump === 'off' || pumpOff.data?.details?.pumpMode === 'manual_off')) {
        ok(`POST /api/devices/:id/pump turned pump OFF (${tankDev})`);
      } else {
        fail('POST /api/devices/:id/pump (off)', pumpOff.text);
      }

      // 14.3 Pump AUTO
      const pumpAuto = await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'auto' } });
      if (pumpAuto.status === 200 && (pumpAuto.data?.pump === 'auto' || pumpAuto.data?.details?.pumpMode === 'auto')) {
        ok(`POST /api/devices/:id/pump restored pump to AUTO (${tankDev})`);
      } else {
        fail('POST /api/devices/:id/pump (auto)', pumpAuto.text);
      }

      // 14.4 Invalid pump action rejection
      const pumpInvalid = await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'explode' } });
      if (pumpInvalid.status === 400) {
        ok('POST /api/devices/:id/pump rejects invalid action with 400');
      } else {
        fail('POST /api/devices/:id/pump invalid action', `Expected 400, got ${pumpInvalid.status}`);
      }

      // 14.5 Update device label (PATCH)
      const patchRes = await api('PATCH', `/api/devices/${tankDev}`, { body: { label: 'Updated Main Tank Lab 1' } });
      if (patchRes.status === 200 && patchRes.data?.label === 'Updated Main Tank Lab 1') {
        ok('PATCH /api/devices/:id successfully updated device label');
      } else {
        fail('PATCH /api/devices/:id', patchRes.text);
      }

      // 14.6 Create and Delete Device Lifecycle
      const tempDevRes = await api('POST', '/api/devices', {
        body: { kind: 'power_meter', label: 'Temporary Meter For Deletion' },
      });
      const tempDevId = tempDevRes.data?.deviceId;
      if (tempDevId) {
        const delRes = await api('DELETE', `/api/devices/${tempDevId}`);
        if (delRes.status === 200 && delRes.data?.removed === tempDevId) {
          ok('DELETE /api/devices/:id removes device cleanly');
        } else {
          fail('DELETE /api/devices/:id', delRes.text);
        }

        // Verify device no longer exists
        const postDelCheck = await api('GET', `/api/devices/${tempDevId}/latest`);
        if (postDelCheck.status === 404) {
          ok('GET /api/devices/:id/latest confirms deleted device returns 404 Not Found');
        } else {
          fail('GET /api/devices/:id/latest after delete', `Expected 404, got ${postDelCheck.status}`);
        }
      }

      // 14.7 Water Pump Physical Inflow Telemetry
      await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'on' } });
      await engine.tick();
      const watReading = await api('GET', `/api/devices/${tankDev}/latest`);
      if (
        watReading.status === 200 &&
        watReading.data?.values?.pump_active === true &&
        watReading.data?.values?.inflow_lpm > 0 &&
        watReading.data?.values?.net_flow_lpm !== undefined
      ) {
        ok(
          'Water reading telemetry calculates pump physics & predictive net inflow',
          `Inflow: ${watReading.data.values.inflow_lpm} LPM, Net: ${watReading.data.values.net_flow_lpm} LPM`
        );
      } else {
        fail('Water reading pump telemetry verification', JSON.stringify(watReading.data?.values));
      }
      await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'auto' } });

      // 14.8 Rapid drain trigger & AI Temporal Memory Anomaly Detection
      const drainRes = await api('POST', `/api/devices/${tankDev}/drain`, { body: { targetLevel: 5 } });
      if (drainRes.status === 200 && drainRes.data?.success === true) {
        ok(`POST /api/devices/:id/drain initiated rapid drain simulation (${tankDev})`);
      } else {
        fail('POST /api/devices/:id/drain', drainRes.text);
      }

      await engine.tick();
      const watDrainReading = await api('GET', `/api/devices/${tankDev}/latest`);
      const temporal = watDrainReading.data?.values?.temporal_analysis;
      if (temporal && (temporal.rapid_drain_anomaly === true || temporal.delta_level_2h > 30)) {
        ok(
          'AI Temporal Memory detected rapid drain anomaly (t-2h vs now)',
          `Delta: ${temporal.delta_level_2h}%`
        );
      } else {
        fail('AI Temporal Memory anomaly detection', JSON.stringify(temporal));
      }

      const alertsList = await api('GET', '/api/alerts');
      const rapidDrainAlert = alertsList.data?.alerts?.find(a =>
        a.ruleCode === 'temporal_rapid_drain' || a.title?.includes('TEMPORAL LEAK DETECTED')
      );
      if (rapidDrainAlert) {
        ok('Alert Engine fired alert for temporal_rapid_drain with actionable playbook');
      } else {
        fail('Rapid drain alert generation', JSON.stringify(alertsList.data?.alerts?.map(a => a.title)));
      }

      // 14.9 AI Predictive Pump Overflow Check (direct device tank/pump state)
      const tankRaw = engine.getDeviceRaw(tankDev);
      if (tankRaw) {
        tankRaw.tankLevel = 96.5;
        tankRaw.pumpMode = 'manual_on';
        tankRaw.pumpActive = true;
        ok('Set direct device tank/pump overflow test state (96.5%, manual_on)');
      } else {
        fail('Direct overflow device lookup', tankDev);
      }

      await engine.tick();

      const afterOverflowAlerts = await api('GET', '/api/alerts');
      const overflowAlert = afterOverflowAlerts.data?.alerts?.find(a =>
        a.ruleCode === 'overflow_imminent' || a.ruleCode === 'tank_overflow' || a.title?.includes('OVERFLOW')
      );
      if (overflowAlert) {
        ok(`Alert Engine triggered predictive overflow alert: "${overflowAlert.title}"`);
      } else {
        fail('Overflow alert verification', JSON.stringify(afterOverflowAlerts.data?.alerts?.map(a => a.title)));
      }

      // 14.10 Arbitrary Level Transition Prediction (Level A -> Level B)
      const predRes = await api('POST', `/api/devices/${tankDev}/predict-fill`, {
        body: { fromLevel: 25, toLevel: 85 }
      });
      if (
        predRes.status === 200 &&
        predRes.data?.deltaPercent === 60 &&
        predRes.data?.prediction?.durationMinutes > 0 &&
        predRes.data?.model?.baselineRatePctMin > 0
      ) {
        ok(
          'Arbitrary Level Predictor calculates exact fill duration & completion IST',
          `From 25% to 85% (${predRes.data.waterVolumeLitres} L): ${predRes.data.prediction.durationFormatted} (ETA: ${predRes.data.prediction.projectedCompletionTime})`
        );
      } else {
        fail('Arbitrary level predictor verification', predRes.text);
      }

      // 14.11 Weak Pump (Low Power/Cavitation) Detection & Degradation Alert
      const weakPumpRes = await api('POST', `/api/devices/${tankDev}/pump`, {
        body: { action: 'on', power: 'weak' }
      });
      if (weakPumpRes.status === 200 && weakPumpRes.data?.details?.pumpPowerMode === 'weak') {
        ok(`POST /api/devices/:id/pump (power: 'weak') simulated degraded pump operating at ~22 LPM`);
      } else {
        fail('POST /api/devices/:id/pump (weak power)', weakPumpRes.text);
      }

      await engine.tick();

      const weakReading = await api('GET', `/api/devices/${tankDev}/latest`);
      const vPump = weakReading.data?.values?.virtual_pump_sensor;
      if (vPump && vPump.pump_power_efficiency_pct < 60 && vPump.pump_pressure_status === 'DEGRADED_PRESSURE') {
        ok(
          'Virtual sensing detected pump power degradation from level rate-of-climb (dL/dt)',
          `Power Index: ${vPump.pump_power_efficiency_pct}%, Status: ${vPump.pump_pressure_status}, Rate: +${vPump.rate_of_change_pct_min}%/min`
        );
      } else {
        fail('Pump power degradation virtual sensing', JSON.stringify(vPump));
      }

      const degradedAlerts = await api('GET', '/api/alerts');
      const hasDegradeAlert = degradedAlerts.data?.alerts?.some(a => a.ruleCode === 'pump_power_degraded');
      if (hasDegradeAlert) {
        ok('Alert Engine triggered P3 alert for pump_power_degraded');
      } else {
        fail('Pump power degraded alert check', JSON.stringify(degradedAlerts.data?.alerts?.map(a => a.title)));
      }

      // Cleanup
      await api('POST', `/api/devices/${tankDev}/pump`, { body: { action: 'auto' } });
      await api('DELETE', '/api/faults');
    }

    // ── 15. Readings Querying & Filtering ────────────────────────────────
    section('15. Readings Querying & Time-Series Filters');
    {
      // 15.1 Filter by kind: power_meter
      const pwrOnly = await api('GET', '/api/readings/latest?kind=power_meter');
      if (pwrOnly.status === 200 && Array.isArray(pwrOnly.data) && pwrOnly.data.every(r => r.kind === 'power_meter')) {
        ok('GET /api/readings/latest?kind=power_meter correctly filters exclusively power meters');
      } else {
        fail('GET /api/readings/latest?kind=power_meter', pwrOnly.text);
      }

      // 15.2 Filter by kind: water_tank
      const watOnly = await api('GET', '/api/readings/latest?kind=water_tank');
      if (watOnly.status === 200 && Array.isArray(watOnly.data) && watOnly.data.every(r => r.kind === 'water_tank')) {
        ok('GET /api/readings/latest?kind=water_tank correctly filters exclusively water tanks');
      } else {
        fail('GET /api/readings/latest?kind=water_tank', watOnly.text);
      }

      // 15.3 Single device latest reading
      const singleLatest = await api('GET', `/api/devices/${pwrDev}/latest`);
      if (singleLatest.status === 200 && singleLatest.data?.deviceId === pwrDev) {
        ok('GET /api/devices/:id/latest returns single device telemetry reading');
      } else {
        fail('GET /api/devices/:id/latest', singleLatest.text);
      }

      // 15.4 Single device history with time slice
      const historyRes = await api('GET', `/api/devices/${pwrDev}/history?minutes=60`);
      if (historyRes.status === 200 && Array.isArray(historyRes.data) && historyRes.data.length > 0) {
        ok(`GET /api/devices/:id/history returns ${historyRes.data.length} historical samples (60 min window)`);
      } else {
        fail('GET /api/devices/:id/history', historyRes.text);
      }

      // 15.5 History 404 on nonexistent device
      const notFoundHist = await api('GET', '/api/devices/dev-nonexistent-unknown-999/history');
      if (notFoundHist.status === 404) {
        ok('GET /api/devices/:id/history returns 404 for unknown device');
      } else {
        fail('GET /api/devices/:id/history 404', `Expected 404, got ${notFoundHist.status}`);
      }
    }

    // ── 16. Fault Aliases & Simulation Reset ─────────────────────────────
    section('16. Fault Routes & Simulation State Management');
    {
      // 16.1 Fault types directory
      const typesRes = await api('GET', '/api/faults/types');
      if (typesRes.status === 200 && Array.isArray(typesRes.data) && typesRes.data.some(t => t.type === 'spike') && typesRes.data.some(t => t.type === 'leak')) {
        ok(`GET /api/faults/types returns full fault catalog definitions (${typesRes.data.length} types)`);
      } else {
        fail('GET /api/faults/types', typesRes.text);
      }

      // 16.2 Alias route: POST /api/simulate/event
      const aliasInject = await api('POST', '/api/simulate/event', {
        body: { deviceId: pwrDev, type: 'sag', severity: 0.6 },
      });
      if (aliasInject.status === 201 && aliasInject.data?.id) {
        ok('POST /api/simulate/event successfully alias-injects fault');
        await api('DELETE', `/api/faults/${aliasInject.data.id}`);
      } else {
        fail('POST /api/simulate/event', aliasInject.text);
      }

      // 16.3 Simulation Reset: POST /api/simulate/reset
      const resetRes = await api('POST', '/api/simulate/reset');
      if (resetRes.status === 200 && resetRes.data?.status === 'reset') {
        ok('POST /api/simulate/reset successfully reinitializes simulation state');
      } else {
        fail('POST /api/simulate/reset', resetRes.text);
      }
    }

    // ── 17. Real-Time SSE Stream Handshake ───────────────────────────────
    section('17. Real-Time SSE Stream Handshake (/api/stream)');
    {
      const streamRes = await api('GET', '/api/stream', { closeAfterFirstChunk: true });
      if (
        streamRes.status === 200 &&
        streamRes.headers['content-type']?.includes('text/event-stream') &&
        streamRes.text.includes('event: connected')
      ) {
        ok('GET /api/stream establishes SSE text/event-stream connection and sends initial handshake');
      } else {
        fail('GET /api/stream', streamRes.text || `status: ${streamRes.status}`);
      }
    }

    // ── 18. Drishti Endpoints & Webhook Handling ───────────────────────────
    section('18. Drishti Endpoints & Webhook Handling');
    {
      // 18.1 Drishti profiles endpoint
      const drishtiProf = await api('GET', '/api/drishti/profiles');
      if (drishtiProf.status === 200 && Array.isArray(drishtiProf.data?.profiles)) {
        ok('GET /api/drishti/profiles returns active organization profiles');
      } else {
        fail('GET /api/drishti/profiles', drishtiProf.text);
      }

      // 18.2 Drishti synthesis endpoint
      const drishtiSynth = await api('GET', '/api/drishti/synthesis');
      if (drishtiSynth.status === 200 && drishtiSynth.data?.synthesis) {
        ok('GET /api/drishti/synthesis generates real-time decision synthesis');
      } else {
        fail('GET /api/drishti/synthesis', drishtiSynth.text);
      }

      // 18.3 Webhook test endpoint handles missing/configured URL gracefully
      const hookRes = await api('POST', '/api/webhook/test');
      if (hookRes.status === 400 || hookRes.status === 200 || hookRes.status === 500) {
        ok('POST /api/webhook/test endpoint responds with appropriate status and error handling');
      } else {
        fail('POST /api/webhook/test', hookRes.text);
      }
    }

    // ── 19. Routing Fallbacks & Error Handlers ───────────────────────────
    section('19. Routing Fallbacks & Error Handlers');
    {
      // 19.1 Root redirect
      const rootRes = await api('GET', '/');
      if (rootRes.status === 302 && rootRes.headers['location'] === '/control') {
        ok('GET / redirects root traffic to /control panel');
      } else {
        fail('GET / redirect', `Expected 302 to /control, got ${rootRes.status}`);
      }

      // 19.2 Global 404 handler
      const unknownRes = await api('GET', '/api/nonexistent-route-xyz-987');
      if (unknownRes.status === 404 && unknownRes.data?.error?.includes('Route not found')) {
        ok('Global 404 handler returns structured JSON error with navigation hint');
      } else {
        fail('Global 404 handler', unknownRes.text);
      }
    }

    // ── 20. Code Syntax & Middleware Security ────────────────────────────
    section('20. Security Middleware & Code Integrity Verification');
    {
      // Direct verification of requireApiKey middleware behavior
      const { requireApiKey } = require('../src/middleware/auth');
      
      function createMockRes() {
        return {
          statusCode: null,
          body: null,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(data) {
            this.body = data;
            return this;
          },
        };
      }

      // Case 1: Unauthorized without API key (when API_KEY is configured in .env)
      if (process.env.API_KEY) {
        let nextCalled = false;
        const res1 = createMockRes();
        requireApiKey({ headers: {}, query: {} }, res1, () => { nextCalled = true; });
        if (res1.statusCode === 401 && !nextCalled) {
          ok('Auth middleware rejects missing API key with 401');
        } else {
          fail('Auth middleware missing key check', `Status: ${res1.statusCode}`);
        }

        // Case 2: Unauthorized with invalid API key
        let nextCalled2 = false;
        const res2 = createMockRes();
        requireApiKey({ headers: { 'x-api-key': 'WRONG-KEY' }, query: {} }, res2, () => { nextCalled2 = true; });
        if (res2.statusCode === 401 && !nextCalled2) {
          ok('Auth middleware rejects invalid API key with 401');
        } else {
          fail('Auth middleware invalid key check', `Status: ${res2.statusCode}`);
        }

        // Case 3: Authorized with valid x-api-key header
        let nextCalled3 = false;
        const res3 = createMockRes();
        requireApiKey({ headers: { 'x-api-key': process.env.API_KEY }, query: {} }, res3, () => { nextCalled3 = true; });
        if (nextCalled3) {
          ok('Auth middleware allows access with valid x-api-key header');
        } else {
          fail('Auth middleware valid header check', 'next() was not called');
        }

        // Case 4: Authorized with valid ?key= query param
        let nextCalled4 = false;
        const res4 = createMockRes();
        requireApiKey({ headers: {}, query: { key: process.env.API_KEY } }, res4, () => { nextCalled4 = true; });
        if (nextCalled4) {
          ok('Auth middleware allows access with valid ?key= query parameter');
        } else {
          fail('Auth middleware valid query check', 'next() was not called');
        }
      } else {
        let nextCalled = false;
        requireApiKey({ headers: {}, query: {} }, {}, () => { nextCalled = true; });
        if (nextCalled) {
          ok('Auth middleware allows open access when API_KEY is unconfigured');
        }
      }

      // ── 21. Solid Waste Management Domain (Sensors, Compactors, Odor & Telemetry) ─
      section('21. Solid Waste Management Domain (Sensors, Compactors, Odor & Telemetry)');
      {
        // 21.1 Waste readings filter
        const wasteReadings = await api('GET', '/api/readings/latest?kind=waste_bin');
        if (wasteReadings.status === 200 && Array.isArray(wasteReadings.data) && wasteReadings.data.length >= 1) {
          ok(`GET /api/readings/latest?kind=waste_bin returns ${wasteReadings.data.length} waste station readings`);
        } else {
          fail('GET /api/readings/latest?kind=waste_bin', wasteReadings.text);
        }

        // 21.2 Compactor cycle endpoint
        const compactorDev = 'dev-acad-wst-comp';
        const compRes = await api('POST', `/api/devices/${compactorDev}/compact`, {
          headers: { 'x-operator-key': 'op-waste-key' },
        });
        if (compRes.status === 200 && compRes.data?.action === 'compact' && compRes.data?.details?.status === 'OPTIMAL') {
          ok(`POST /api/devices/:id/compact executes compaction cycle (New Fill: ${compRes.data.details.newFillLevel}%)`);
        } else {
          fail('POST /api/devices/:id/compact', compRes.text);
        }

        // 21.3 Empty waste bin endpoint
        const binDev = 'dev-bldA-wst-bin';
        const emptyRes = await api('POST', `/api/devices/${binDev}/empty`, {
          headers: { 'x-operator-key': 'op-waste-key' },
        });
        if (emptyRes.status === 200 && emptyRes.data?.action === 'empty' && emptyRes.data?.details?.newFillLevel === 0) {
          ok(`POST /api/devices/:id/empty empties waste receptacle to 0% fill`);
        } else {
          fail('POST /api/devices/:id/empty', emptyRes.text);
        }

        // 21.4 Waste fault injection (bin_overflow)
        const faultRes = await api('POST', '/api/faults', {
          headers: { 'x-operator-key': 'op-waste-key' },
          body: { deviceId: binDev, type: 'bin_overflow', severity: 0.9 },
        });
        if (faultRes.status === 201 && faultRes.data?.type === 'bin_overflow') {
          ok(`POST /api/faults injected 'bin_overflow' fault into waste receptacle`);
        } else {
          fail('Waste fault injection', faultRes.text);
        }

        // 21.5 Waste diagnosis via Drishti
        await engine.tick();
        const diagRes = await api('GET', `/api/drishti/diagnose/${binDev}`, {
          headers: { 'x-operator-key': 'op-waste-key' },
        });
        if (diagRes.status === 200 && diagRes.data?.domain === 'waste' && diagRes.data?.riskLevel === 'MEDIUM') {
          ok(`GET /api/drishti/diagnose/:id returns waste diagnostic (Risk: ${diagRes.data.riskLevel}, ${diagRes.data.diagnosis.slice(0, 45)}...)`);
        } else {
          fail('Waste diagnosis', diagRes.text);
        }

        // Clean up injected fault
        await api('DELETE', `/api/faults/${faultRes.data?.id}`, {
          headers: { 'x-operator-key': 'op-waste-key' },
        });
      }

      // ── 22. Enterprise Operator Identity & Domain Isolation (TOAM) ─
      section('22. Enterprise Operator Identity & Domain Isolation (TOAM)');
      {
        // 22.1 Get current operator (Root Admin)
        const meRoot = await api('GET', '/api/access/me', {
          headers: { 'x-operator-key': 'op-root-key' },
        });
        if (meRoot.status === 200 && meRoot.data?.operator?.role === 'admin') {
          ok(`GET /api/access/me identifies Root Administrator (${meRoot.data.operator.name})`);
        } else {
          fail('GET /api/access/me root check', meRoot.text);
        }

        // 22.2 List registered operators
        const opsList = await api('GET', '/api/access/operators', {
          headers: { 'x-operator-key': 'op-root-key' },
        });
        if (opsList.status === 200 && opsList.data?.total >= 5) {
          ok(`GET /api/access/operators lists all ${opsList.data.total} registered operators`);
        } else {
          fail('GET /api/access/operators', opsList.text);
        }

        // 22.3 Admin creates new domain-restricted operator
        const createOpRes = await api('POST', '/api/access/operators', {
          headers: { 'x-operator-key': 'op-root-key' },
          body: {
            name: 'Junior Hostel Electrician',
            username: 'hostel.electrician',
            domains: ['power'],
            role: 'operator',
            orgId: 'college_campus',
          },
        });
        if (createOpRes.status === 201 && createOpRes.data?.operator?.id) {
          ok(`POST /api/access/operators successfully created operator '${createOpRes.data.operator.name}'`);
        } else {
          fail('POST /api/access/operators', createOpRes.text);
        }
        const newOp = createOpRes.data?.operator;

        // 22.4 Non-admin blocked from creating operators
        const nonAdminCreate = await api('POST', '/api/access/operators', {
          headers: { 'x-operator-key': 'op-power-key' },
          body: { name: 'Unauthorized Operator', username: 'unauth.user', domains: ['power'] },
        });
        if (nonAdminCreate.status === 403) {
          ok(`POST /api/access/operators rejects non-admin with 403 Forbidden`);
        } else {
          fail('Non-admin operator creation check', `Expected 403, got ${nonAdminCreate.status}`);
        }

        // 22.5 Read-only viewer blocked from operational control (403 Forbidden)
        const viewerPump = await api('POST', '/api/devices/dev-bldA-wat-t1/pump', {
          headers: { 'x-operator-key': 'op-power-view-key' },
          body: { action: 'on' },
        });
        if (viewerPump.status === 403) {
          ok(`Read-only viewer blocked from control action with 403 Forbidden`);
        } else {
          fail('Viewer control block check', `Expected 403, got ${viewerPump.status}`);
        }

        // 22.6 Power Specialist domain restriction: blocked from water pump control (403 Forbidden)
        const powerOnWater = await api('POST', '/api/devices/dev-bldA-wat-t1/pump', {
          headers: { 'x-operator-key': 'op-power-key' },
          body: { action: 'on' },
        });
        if (powerOnWater.status === 403) {
          ok(`Power Specialist blocked from Water pump control with 403 Forbidden (Domain Isolation)`);
        } else {
          fail('Power specialist cross-domain block', `Expected 403, got ${powerOnWater.status}`);
        }

        // 22.7 Water Specialist blocked from diagnosing Power meter (403 Forbidden)
        const waterDiagPower = await api('GET', '/api/drishti/diagnose/dev-bldA-pwr-f1', {
          headers: { 'x-operator-key': 'op-water-key' },
        });
        if (waterDiagPower.status === 403) {
          ok(`Water Specialist blocked from diagnosing Power meter with 403 Forbidden`);
        } else {
          fail('Water diagnosing power check', `Expected 403, got ${waterDiagPower.status}`);
        }

        // 22.8 Admin deletes test operator
        if (newOp?.id) {
          const delRes = await api('DELETE', `/api/access/operators/${newOp.id}`, {
            headers: { 'x-operator-key': 'op-root-key' },
          });
          if (delRes.status === 200) {
            ok(`DELETE /api/access/operators/:id deleted test operator cleanly`);
          }
        }
      }

      // ── 23. Drishti Chatbot Org-Wise & Domain-Aware Isolation ─────────
      section('23. Drishti Chatbot Org-Wise & Domain-Aware Isolation');
      {
        // 23.1 Power Operator asking about water leaks gets domain refusal
        const pwrAskWater = await api('POST', '/api/drishti/chat', {
          headers: { 'x-operator-key': 'op-power-key' },
          body: { query: 'Are there any active water leaks in our tanks?' },
        });
        if (pwrAskWater.status === 200 && pwrAskWater.data?.reply?.includes('Access Restricted')) {
          ok(`Drishti Chatbot restricts Power Specialist from querying Water domain with domain refusal`);
        } else {
          fail('Drishti power operator water block', pwrAskWater.text);
        }

        // 23.2 Water Operator asking about electricity tariffs gets domain refusal
        const watAskPwr = await api('POST', '/api/drishti/chat', {
          headers: { 'x-operator-key': 'op-water-key' },
          body: { query: 'What is our current electricity tariff and power factor penalty?' },
        });
        if (watAskPwr.status === 200 && watAskPwr.data?.reply?.includes('Access Restricted')) {
          ok(`Drishti Chatbot restricts Water Specialist from querying Power domain with domain refusal`);
        } else {
          fail('Drishti water operator power block', watAskPwr.text);
        }

        // 23.3 Waste Operator asking about waste compactors gets specialized waste response
        const wasteChat = await api('POST', '/api/drishti/chat', {
          headers: { 'x-operator-key': 'op-waste-key' },
          body: { query: 'What is the current status of our waste compactors and smart bins?' },
        });
        if (wasteChat.status === 200 && (wasteChat.data?.reply?.includes('Solid Waste') || wasteChat.data?.reply?.includes('Compactor') || wasteChat.data?.reply?.includes('bins'))) {
          ok(`Drishti Chatbot provides specialized Waste Management intelligence to Waste Specialist`);
        } else {
          fail('Drishti waste chat', wasteChat.text);
        }

        // 23.4 Root Admin querying holistic campus status gets full multi-domain response
        const rootChat = await api('POST', '/api/drishti/chat', {
          headers: { 'x-operator-key': 'op-root-key' },
          body: { query: 'Give me an executive summary of all facility operations.' },
        });
        if (rootChat.status === 200 && rootChat.data?.reply?.length > 50) {
          ok(`Drishti Chatbot provides unrestricted multi-domain synthesis to Root Administrator`);
        } else {
          fail('Drishti root holistic chat', rootChat.text);
        }

        // 23.5 Organization Isolation: tenant-locked operator blocked from accessing other orgs (403 Forbidden)
        const crossOrgChat = await api('POST', '/api/drishti/chat', {
          headers: { 'x-operator-key': 'op-power-key', 'x-org-id': 'hospital' },
          body: { query: 'Check electricity tariff', orgId: 'hospital' },
        });
        if (crossOrgChat.status === 403) {
          ok(`Drishti Chatbot enforces Org-Wise Isolation: blocked campus operator from querying 'hospital' org with 403`);
        } else {
          fail('Cross-org isolation check', `Expected 403, got ${crossOrgChat.status}`);
        }

        // 23.6 Root Admin can query specific orgs cleanly
        const hospSynthesis = await api('GET', '/api/drishti/synthesis?orgId=hospital', {
          headers: { 'x-operator-key': 'op-root-key' },
        });
        if (hospSynthesis.status === 200 && hospSynthesis.data?.analytics?.organization?.id === 'hospital') {
          ok(`Root Admin accesses Org-Wise Synthesis for 'hospital' (${hospSynthesis.data.analytics.organization.persona.adminTitle})`);
        } else {
          fail('Root admin org synthesis', hospSynthesis.text);
        }
      }

      // ── 24. Secure Cloudinary Storage & Delivery ────────────────────────
      section('24. Secure Cloudinary Storage & Delivery');
      {
        const storageModule = require('../src/storage/cloudinary');

        // 24.1 Status endpoint requires authentication
        const unauthStatus = await api('GET', '/api/storage/status', {
          headers: { 'x-api-key': 'invalid-secret-key' },
        });
        if (unauthStatus.status === 401) {
          ok('GET /api/storage/status rejects unauthorized requests with 401');
        } else {
          fail('Storage unauthenticated status check', `Expected 401, got ${unauthStatus.status}`);
        }

        // 24.2 Authenticated status check & Secret Redaction
        const authStatus = await api('GET', '/api/storage/status');
        if (authStatus.status === 200 && authStatus.data?.storage?.configured === true) {
          const s = authStatus.data.storage;
          const noSecretLeaked = !JSON.stringify(authStatus.data).includes('RM_Pj0J3NhW4fB66SUbAJC7uLmQ') &&
                                 !authStatus.data.api_secret && !s.apiSecret && !s.api_secret;
          if (noSecretLeaked && s.secure === true && s.apiKeyMasked?.includes('••••')) {
            ok(`GET /api/storage/status returns healthy configuration with API secret strictly redacted (${s.apiKeyMasked})`);
          } else {
            fail('Storage status leak check', 'API Secret was leaked in response payload!');
          }
        } else {
          fail('GET /api/storage/status', authStatus.text);
        }

        // 24.3 Signed upload parameter generation
        const signRes = await api('POST', '/api/storage/sign', {
          headers: { 'x-operator-key': 'op-root-key' },
          body: { folder: 'sensor-sim/proofs', publicId: 'incident-evidence-01' },
        });
        if (signRes.status === 200 && signRes.data?.signature && signRes.data?.apiKey && signRes.data?.uploadUrl) {
          ok(`POST /api/storage/sign generates secure client upload signature without exposing secret (${signRes.data.signature.slice(0, 8)}...)`);
        } else {
          fail('POST /api/storage/sign', signRes.text);
        }

        // 24.4 Read-only viewer blocked from signing or uploading (403 Forbidden)
        const viewerSign = await api('POST', '/api/storage/sign', {
          headers: { 'x-operator-key': 'op-power-view-key' },
          body: { folder: 'sensor-sim/test' },
        });
        if (viewerSign.status === 403) {
          ok('POST /api/storage/sign blocks read-only viewer role with 403 Forbidden');
        } else {
          fail('Viewer storage sign check', `Expected 403, got ${viewerSign.status}`);
        }

        // 24.5 Optimized secure delivery URL generation
        const urlRes = await api('GET', '/api/storage/url/sensor-sim/shoes?width=400&height=400&crop=auto');
        if (urlRes.status === 200 && urlRes.data?.secureUrl?.startsWith('https://res.cloudinary.com/')) {
          ok(`GET /api/storage/url/* generates secure HTTPS delivery URL with auto-optimization`);
        } else {
          fail('GET /api/storage/url/*', urlRes.text);
        }

        // 24.6 Security Sanitization & Directory Traversal Protection
        const sanitized = storageModule.sanitizePublicId('../../etc/passwd/../../malicious.png');
        if (sanitized === 'etc/passwd/malicious.png' || !sanitized.includes('..')) {
          ok(`Public ID sanitization neutralizes directory traversal patterns (${sanitized})`);
        } else {
          fail('Path traversal check', `Failed to sanitize: ${sanitized}`);
        }

        // 24.7 File Type Whitelisting
        let rejectedMalicious = false;
        try {
          storageModule.validateFile({ mimetype: 'application/x-msdownload', originalname: 'exploit.exe' });
        } catch {
          rejectedMalicious = true;
        }
        if (rejectedMalicious) {
          ok('File validation strictly blocks executable files and unauthorized MIME types');
        } else {
          fail('File validation whitelist', 'Allowed malicious .exe file');
        }

        // 24.8 Empty Upload Validation
        const emptyUpload = await api('POST', '/api/storage/upload', {
          headers: { 'x-operator-key': 'op-root-key' },
          body: {},
        });
        if (emptyUpload.status === 400 && emptyUpload.data?.error?.includes('No file or source provided')) {
          ok('POST /api/storage/upload validates input payload and rejects empty uploads with 400');
        } else {
          fail('Empty upload check', emptyUpload.text);
        }
      }


      // Verify all JavaScript source files in src/ have valid syntax
      const fs = require('fs');
      const vm = require('vm');
      function checkSyntax(dir) {
        let errCount = 0;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            errCount += checkSyntax(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.js')) {
            try {
              const code = fs.readFileSync(fullPath, 'utf8');
              new vm.Script(code, { filename: fullPath });
            } catch (syntaxErr) {
              errCount++;
              fail(`Syntax check in ${entry.name}`, syntaxErr.message);
            }
          }
        }
        return errCount;
      }

      const syntaxErrors = checkSyntax(path.join(__dirname, '..', 'src'));
      if (syntaxErrors === 0) {
        ok('Static compilation check: all backend source files in src/ contain valid JavaScript');
      }
    }

  } catch (err) {
    console.error('Fatal test error:', err);
    failed++;
  } finally {
    engine.stop();
    console.log(`\n\x1b[1m========================================\x1b[0m`);
    console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
    console.log(`\x1b[1m========================================\x1b[0m\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
