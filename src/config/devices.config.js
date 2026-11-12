/**
 * devices.config.js
 * ─────────────────────────────────────────────────────────────
 * Seed device definitions loaded on startup.
 *
 * HOW TO ADD A DEVICE
 * ───────────────────
 * 1. Copy any entry below and give it a unique `deviceId`.
 * 2. Set `kind` to 'power_meter' or 'water_tank'.
 * 3. Set `label` to a human-readable description — this is purely
 *    for the control panel; the main website manages the actual
 *    building/floor mapping.
 * 4. Set `buildingType` to pick the right daily load profile:
 *      'hostel' | 'academic' | 'labs' | 'library'
 * 5. Adjust `baseline` values to match real-world specs.
 * 6. For water_tank devices, set `tankCapacityLitres`.
 * 7. Restart the server — the device appears immediately.
 *
 * NOTE: claimCode and secret are generated at runtime (crypto).
 *       They are NOT stored here.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * @typedef {Object} SeedDevice
 * @property {string}  deviceId          - Unique identifier (must be URL-safe)
 * @property {'power_meter'|'water_tank'} kind
 * @property {string}  label             - Human-readable label for control panel
 * @property {'hostel'|'academic'|'labs'|'library'} buildingType - Determines daily load pattern
 * @property {Object}  baseline          - Nominal (100% load) values
 * @property {number}  [tankCapacityLitres] - Required for water_tank; total tank volume
 */

/** @type {SeedDevice[]} */
const SEED_DEVICES = [

  // ── Building A (Hostel) ─────────────────────────────────────────────────
  // 4 power meters (one per floor) + 2 water tanks

  {
    deviceId: 'dev-bldA-pwr-f1',
    device_id: 'ESP32_HA_F1',
    sensor_id: 'PZEM_004T_HA_F1',
    kind: 'power_meter',
    label: 'Building A - Floor 1',
    buildingType: 'hostel',
    baseline: { power_kw: 48, voltage: 230, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-bldA-pwr-f2',
    device_id: 'ESP32_HA_F2',
    sensor_id: 'PZEM_004T_HA_F2',
    kind: 'power_meter',
    label: 'Building A - Floor 2',
    buildingType: 'hostel',
    baseline: { power_kw: 52, voltage: 230, power_factor: 0.91 },
  },
  {
    deviceId: 'dev-bldA-pwr-f3',
    device_id: 'ESP32_HA_F3',
    sensor_id: 'PZEM_004T_HA_F3',
    kind: 'power_meter',
    label: 'Building A - Floor 3',
    buildingType: 'hostel',
    baseline: { power_kw: 50, voltage: 231, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-bldA-pwr-f4',
    device_id: 'ESP32_HA_F4',
    sensor_id: 'PZEM_004T_HA_F4',
    kind: 'power_meter',
    label: 'Building A - Floor 4',
    buildingType: 'hostel',
    baseline: { power_kw: 45, voltage: 230, power_factor: 0.90 },
  },

  // ── Academic Block ───────────────────────────────────────────────────────
  // 3 power meters

  {
    deviceId: 'dev-acad-pwr-1',
    device_id: 'ESP32_AB_F1',
    sensor_id: 'PZEM_004T_AB_F1',
    kind: 'power_meter',
    label: 'Academic Block - Wing A',
    buildingType: 'academic',
    baseline: { power_kw: 75, voltage: 230, power_factor: 0.93 },
  },
  {
    deviceId: 'dev-acad-pwr-2',
    device_id: 'ESP32_AB_F2',
    sensor_id: 'PZEM_004T_AB_F2',
    kind: 'power_meter',
    label: 'Academic Block - Wing B',
    buildingType: 'academic',
    baseline: { power_kw: 68, voltage: 231, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-acad-pwr-3',
    device_id: 'ESP32_AUDIT',
    sensor_id: 'PZEM_004T_AUDIT',
    kind: 'power_meter',
    label: 'Academic Block - Auditorium',
    buildingType: 'academic',
    baseline: { power_kw: 95, voltage: 230, power_factor: 0.88 },
  },

  // ── Library ─────────────────────────────────────────────────────────────
  // 2 power meters

  {
    deviceId: 'dev-lib-pwr-1',
    device_id: 'ESP32_LIB_F1',
    sensor_id: 'PZEM_004T_LIB_F1',
    kind: 'power_meter',
    label: 'Library - Main Hall',
    buildingType: 'library',
    baseline: { power_kw: 42, voltage: 230, power_factor: 0.94 },
  },
  {
    deviceId: 'dev-lib-pwr-2',
    device_id: 'ESP32_LIB_F2',
    sensor_id: 'PZEM_004T_LIB_F2',
    kind: 'power_meter',
    label: 'Library - Study Wing',
    buildingType: 'library',
    baseline: { power_kw: 30, voltage: 229, power_factor: 0.93 },
  },

  // ── Labs ─────────────────────────────────────────────────────────────────
  // 3 power meters

  {
    deviceId: 'dev-lab-pwr-1',
    device_id: 'ESP32_LAB_CHEM',
    sensor_id: 'PZEM_004T_LAB_CHEM',
    kind: 'power_meter',
    label: 'Labs - Chemistry Lab',
    buildingType: 'labs',
    baseline: { power_kw: 88, voltage: 230, power_factor: 0.90 },
  },
  {
    deviceId: 'dev-lab-pwr-2',
    device_id: 'ESP32_LAB_PHY',
    sensor_id: 'PZEM_004T_LAB_PHY',
    kind: 'power_meter',
    label: 'Labs - Physics Lab',
    buildingType: 'labs',
    baseline: { power_kw: 72, voltage: 231, power_factor: 0.91 },
  },
  {
    deviceId: 'dev-lab-pwr-3',
    device_id: 'ESP32_LAB_BIO',
    sensor_id: 'PZEM_004T_LAB_BIO',
    kind: 'power_meter',
    label: 'Labs - Biology / Biotech Lab',
    buildingType: 'labs',
    baseline: { power_kw: 65, voltage: 230, power_factor: 0.89 },
  },

  // ── Waste Management Stations & Receptacles ──────────────────────────────
  // 4 smart waste stations: smart bins & compactor stations

  {
    deviceId: 'dev-bldA-wst-bin',
    kind: 'waste_bin',
    label: 'Building A - Smart Bio-Bin',
    buildingType: 'hostel',
    capacityLitres: 240,
    wasteType: 'organic',
    baseline: { accumulation_kg_h: 8, max_weight_kg: 120 },
  },
  {
    deviceId: 'dev-acad-wst-comp',
    kind: 'waste_compactor',
    label: 'Academic Block - Compactor Station',
    buildingType: 'academic',
    capacityLitres: 1200,
    hasCompactor: true,
    wasteType: 'solid_and_paper',
    baseline: { accumulation_kg_h: 22, max_weight_kg: 500 },
  },
  {
    deviceId: 'dev-mess-wst-compost',
    kind: 'waste_bin',
    label: 'Dining Mess - Organic Compost Receptacle',
    buildingType: 'hostel',
    capacityLitres: 600,
    wasteType: 'food_waste',
    baseline: { accumulation_kg_h: 30, max_weight_kg: 350 },
  },
  {
    deviceId: 'dev-lab-wst-hazard',
    kind: 'waste_bin',
    label: 'Central Labs - Hazardous Solid Receptacle',
    buildingType: 'labs',
    capacityLitres: 300,
    wasteType: 'lab_chemical_solid',
    baseline: { accumulation_kg_h: 5, max_weight_kg: 150 },
  },
];

module.exports = { SEED_DEVICES };
