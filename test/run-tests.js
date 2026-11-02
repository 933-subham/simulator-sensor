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
function api(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const req = new Readable({
      read() {
        if (bodyStr) this.push(bodyStr);
        this.push(null);
      },
    });

    req.method = method.toUpperCase();
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
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
      if (res.status === 200 && Array.isArray(devices) && devices.length === 23) {
        ok('GET /api/devices lists all 23 seed devices');
      } else {
        fail('GET /api/devices', `Expected 23 devices, got ${devices?.length}`);
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
      'blackout',
      'pipe-burst',
      'multi-fault',
      'rogue-sensor',
      'replay-attack',
      'data-tampering',
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
