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
    kind: 'power_meter',
    label: 'Building A - Floor 1',
    buildingType: 'hostel',
    baseline: { power_kw: 48, voltage: 230, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-bldA-pwr-f2',
    kind: 'power_meter',
    label: 'Building A - Floor 2',
    buildingType: 'hostel',
    baseline: { power_kw: 52, voltage: 230, power_factor: 0.91 },
  },
  {
    deviceId: 'dev-bldA-pwr-f3',
    kind: 'power_meter',
    label: 'Building A - Floor 3',
    buildingType: 'hostel',
    baseline: { power_kw: 50, voltage: 231, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-bldA-pwr-f4',
    kind: 'power_meter',
    label: 'Building A - Floor 4',
    buildingType: 'hostel',
    baseline: { power_kw: 45, voltage: 230, power_factor: 0.90 },
  },
  {
    deviceId: 'dev-bldA-wat-t1',
    kind: 'water_tank',
    label: 'Building A - Main Tank',
    buildingType: 'hostel',
    baseline: { flow_lpm: 28, pressure_bar: 3.5 },
    tankCapacityLitres: 6000,
  },
  {
    deviceId: 'dev-bldA-wat-t2',
    kind: 'water_tank',
    label: 'Building A - Roof Tank',
    buildingType: 'hostel',
    baseline: { flow_lpm: 18, pressure_bar: 2.8 },
    tankCapacityLitres: 4000,
  },

  // ── Academic Block ───────────────────────────────────────────────────────
  // 3 power meters + 3 water tanks

  {
    deviceId: 'dev-acad-pwr-1',
    kind: 'power_meter',
    label: 'Academic Block - Wing A',
    buildingType: 'academic',
    baseline: { power_kw: 75, voltage: 230, power_factor: 0.93 },
  },
  {
    deviceId: 'dev-acad-pwr-2',
    kind: 'power_meter',
    label: 'Academic Block - Wing B',
    buildingType: 'academic',
    baseline: { power_kw: 68, voltage: 231, power_factor: 0.92 },
  },
  {
    deviceId: 'dev-acad-pwr-3',
    kind: 'power_meter',
    label: 'Academic Block - Auditorium',
    buildingType: 'academic',
    baseline: { power_kw: 95, voltage: 230, power_factor: 0.88 },
  },
  {
    deviceId: 'dev-acad-wat-1',
    kind: 'water_tank',
    label: 'Academic Block - Tank 1',
    buildingType: 'academic',
    baseline: { flow_lpm: 22, pressure_bar: 3.2 },
    tankCapacityLitres: 5000,
  },
  {
    deviceId: 'dev-acad-wat-2',
    kind: 'water_tank',
    label: 'Academic Block - Tank 2',
    buildingType: 'academic',
    baseline: { flow_lpm: 18, pressure_bar: 3.0 },
    tankCapacityLitres: 4000,
  },
  {
    deviceId: 'dev-acad-wat-3',
    kind: 'water_tank',
    label: 'Academic Block - Cooling Tower',
    buildingType: 'academic',
    baseline: { flow_lpm: 35, pressure_bar: 2.6 },
    tankCapacityLitres: 8000,
  },

  // ── Library ─────────────────────────────────────────────────────────────
  // 2 power meters + 2 water tanks

  {
    deviceId: 'dev-lib-pwr-1',
    kind: 'power_meter',
    label: 'Library - Main Hall',
    buildingType: 'library',
    baseline: { power_kw: 42, voltage: 230, power_factor: 0.94 },
  },
  {
    deviceId: 'dev-lib-pwr-2',
    kind: 'power_meter',
    label: 'Library - Study Wing',
    buildingType: 'library',
    baseline: { power_kw: 30, voltage: 229, power_factor: 0.93 },
  },
  {
    deviceId: 'dev-lib-wat-1',
    kind: 'water_tank',
    label: 'Library - Main Tank',
    buildingType: 'library',
    baseline: { flow_lpm: 12, pressure_bar: 3.0 },
    tankCapacityLitres: 3000,
  },
  {
    deviceId: 'dev-lib-wat-2',
    kind: 'water_tank',
    label: 'Library - HVAC Cooling',
    buildingType: 'library',
    baseline: { flow_lpm: 20, pressure_bar: 2.5 },
    tankCapacityLitres: 4500,
  },

  // ── Labs ─────────────────────────────────────────────────────────────────
  // 3 power meters + 4 water tanks (labs are heavy users)

  {
    deviceId: 'dev-lab-pwr-1',
    kind: 'power_meter',
    label: 'Labs - Chemistry Lab',
    buildingType: 'labs',
    baseline: { power_kw: 88, voltage: 230, power_factor: 0.90 },
  },
  {
    deviceId: 'dev-lab-pwr-2',
    kind: 'power_meter',
    label: 'Labs - Physics Lab',
    buildingType: 'labs',
    baseline: { power_kw: 72, voltage: 231, power_factor: 0.91 },
  },
  {
    deviceId: 'dev-lab-pwr-3',
    kind: 'power_meter',
    label: 'Labs - Biology / Biotech Lab',
    buildingType: 'labs',
    baseline: { power_kw: 65, voltage: 230, power_factor: 0.89 },
  },
  {
    deviceId: 'dev-lab-wat-1',
    kind: 'water_tank',
    label: 'Labs - Distilled Water Tank',
    buildingType: 'labs',
    baseline: { flow_lpm: 15, pressure_bar: 4.0 },
    tankCapacityLitres: 3000,
  },
  {
    deviceId: 'dev-lab-wat-2',
    kind: 'water_tank',
    label: 'Labs - Cooling Water Circuit',
    buildingType: 'labs',
    baseline: { flow_lpm: 40, pressure_bar: 3.8 },
    tankCapacityLitres: 7000,
  },
  {
    deviceId: 'dev-lab-wat-3',
    kind: 'water_tank',
    label: 'Labs - Emergency Safety Tank',
    buildingType: 'labs',
    baseline: { flow_lpm: 5, pressure_bar: 2.0 },
    tankCapacityLitres: 2000,
  },
  {
    deviceId: 'dev-lab-wat-4',
    kind: 'water_tank',
    label: 'Labs - Chilled Water Reservoir',
    buildingType: 'labs',
    baseline: { flow_lpm: 30, pressure_bar: 3.5 },
    tankCapacityLitres: 6000,
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
