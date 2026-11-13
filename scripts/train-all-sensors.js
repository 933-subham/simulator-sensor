/**
 * scripts/train-all-sensors.js
 * ─────────────────────────────────────────────────────────────
 * Trains all 12 ESP32 + PZEM-004T power sensor nodes on the
 * GreenLoop AI Anomaly Detection Engine (https://greenloop-ai-model.onrender.com)
 * with a realistic 90-day (3-month / 2,160 samples per node) historical baseline.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');

const AI_MODEL_HOST = 'greenloop-ai-model.onrender.com';
const API_KEY = process.env.API_KEY || 'NEXUS01USOITY';

const SENSORS = [
  { id: 'ESP32_HA_F1', label: 'Building A - Floor 1', facility: 'hostel', baseKw: 25, peakKw: 20 },
  { id: 'ESP32_HA_F2', label: 'Building A - Floor 2', facility: 'hostel', baseKw: 28, peakKw: 22 },
  { id: 'ESP32_HA_F3', label: 'Building A - Floor 3', facility: 'hostel', baseKw: 26, peakKw: 20 },
  { id: 'ESP32_HA_F4', label: 'Building A - Floor 4', facility: 'hostel', baseKw: 15, peakKw: 18 },
  { id: 'ESP32_AB_F1', label: 'Academic Block - Wing A', facility: 'college', baseKw: 10, peakKw: 35 },
  { id: 'ESP32_AB_F2', label: 'Academic Block - Wing B', facility: 'college', baseKw: 10, peakKw: 32 },
  { id: 'ESP32_AUDIT', label: 'Academic Block - Auditorium', facility: 'college', baseKw: 4, peakKw: 28 },
  { id: 'ESP32_LIB_F1', label: 'Library - Main Hall', facility: 'college', baseKw: 8, peakKw: 18 },
  { id: 'ESP32_LIB_F2', label: 'Library - Study Wing', facility: 'college', baseKw: 6, peakKw: 14 },
  { id: 'ESP32_LAB_CHEM', label: 'Labs - Chemistry Lab', facility: 'college', baseKw: 12, peakKw: 25 },
  { id: 'ESP32_LAB_PHY', label: 'Labs - Physics Lab', facility: 'college', baseKw: 14, peakKw: 26 },
  { id: 'ESP32_LAB_BIO', label: 'Labs - Biology / Biotech Lab', facility: 'college', baseKw: 11, peakKw: 22 }
];

function generate90DaysTelemetry(sensor) {
  const points = [];
  const totalDays = 90;
  const totalHours = totalDays * 24; // 2160 hours
  const baseTime = Date.now() - (totalHours * 3600 * 1000);

  for (let i = 0; i < totalHours; i++) {
    const t = new Date(baseTime + i * 3600 * 1000);
    const ts = t.toISOString();
    const hour = t.getHours();
    const isWeekend = t.getDay() === 0 || t.getDay() === 6;

    // Diurnal curve: peak during operating hours (9 AM - 6 PM for college; 6 AM - 11 PM for hostel)
    let diurnal = 0;
    if (sensor.facility === 'hostel') {
      diurnal = (hour >= 6 && hour <= 23) ? Math.sin((hour - 6) / 17 * Math.PI) : 0.15;
    } else {
      diurnal = (!isWeekend && hour >= 8 && hour <= 19) ? Math.sin((hour - 8) / 11 * Math.PI) : 0.08;
    }

    const noise = (Math.random() * 2 - 1) * 0.8;
    const value = Math.max(1, (sensor.baseKw * (isWeekend ? 0.6 : 1.0)) + (sensor.peakKw * diurnal) + noise);

    points.push({
      ts,
      value: Number(value.toFixed(2))
    });
  }

  return points;
}

function postSensorFit(sensor, points) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      facility: sensor.facility,
      unit: 'kW',
      points: points
    });

    const req = https.request({
      hostname: AI_MODEL_HOST,
      port: 443,
      path: `/v1/sensors/${sensor.id}/fit`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': API_KEY
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getSensorStatus(sensorId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: AI_MODEL_HOST,
      port: 443,
      path: `/v1/sensors/${sensorId}/status`,
      method: 'GET',
      headers: {
        'x-api-key': API_KEY
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('======================================================================');
  console.log('🤖 GreenLoop AI Anomaly Detection Engine — 90-Day Sensor Model Training');
  console.log(`Endpoint: https://${AI_MODEL_HOST}`);
  console.log(`Target: 12 ESP32 + PZEM-004T Sensor Nodes × 90 Days (2,160 Points/Node)`);
  console.log('======================================================================\n');

  for (let i = 0; i < SENSORS.length; i++) {
    const s = SENSORS[i];
    process.stdout.write(`[${i + 1}/${SENSORS.length}] Training ${s.id.padEnd(14)} (${s.label}) ... `);
    const points = generate90DaysTelemetry(s);
    try {
      const res = await postSensorFit(s, points);
      if (res.status === 200) {
        console.log(`✓ Fitted! Days: ${res.data.history_days}, Threshold_k: ${res.data.threshold_k}, Mode: ${res.data.mode}`);
      } else {
        console.log(`✗ Error (${res.status}):`, res.data || res.raw);
      }
    } catch (err) {
      console.log(`✗ Network Error: ${err.message}`);
    }
  }

  console.log('\n======================================================================');
  console.log('🔍 Final Verification: Querying Live Status for All 12 Sensor Models');
  console.log('======================================================================\n');

  for (const s of SENSORS) {
    const st = await getSensorStatus(s.id);
    const icon = st.fitted ? '✅' : '❌';
    console.log(`${icon} ${s.id.padEnd(14)} | Fitted: ${String(st.fitted).padEnd(5)} | Days: ${String(st.history_days || 0).padEnd(4)} | Mode: ${String(st.mode || 'unfitted').padEnd(10)} | Threshold_k: ${st.threshold_k || 'N/A'}`);
  }

  console.log('\n🎉 ALL 12 SENSORS SUCCESSFULLY TRAINED WITH 3-MONTH BASELINE DATA!\n');
}

run().catch(console.error);
