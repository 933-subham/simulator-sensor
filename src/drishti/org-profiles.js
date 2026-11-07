/**
 * org-profiles.js
 * ─────────────────────────────────────────────────────────────
 * Multi-Scale Organization Profile Registry.
 *
 * Configures the Drishti Facility Intelligence Studio across:
 *  1. College Campus / University
 *  2. Multi-Specialty Hospital / Healthcare
 *  3. Industrial Plant / Big Power House / Substation
 *  4. Commercial IT Park / Tech Hub
 *  5. Residential Society / Villa / Single House
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const PROFILES = {
  college_campus: {
    id: 'college_campus',
    name: 'College / University Campus',
    category: 'Institutional Campus',
    badge: '🎓 College Campus',
    icon: '🎓',
    scaleTag: 'Academic Blocks, Hostels & Labs',
    plainDescription: 'Designed for colleges, universities, and educational campuses. Tracks student hostels, academic lecture blocks, research labs, mess kitchens, and campus water reservoirs.',
    persona: {
      adminTitle: 'Campus Estate Officer & Registrar',
      leadEngineer: 'Executive Engineer (EE - Electrical & Civil)',
      groundTeam: 'Campus Shift Electrician & Junior Engineer (Civil/PHE)',
      laymanTarget: 'Ensures hostels and classrooms have uninterrupted power and water without blowing up the university electricity and water tanker budget.',
    },
    tariff: {
      categoryName: 'HT-2B Institutional / Educational',
      baseRatePerKwh: 8.50,
      peakSurcharge: 0.20,
      offPeakRebate: 0.15,
      contractedDemandKva: 650,
      pfThreshold: 0.90,
      waterTankerCostPer6000L: 1500,
    },
    benchmarks: {
      waterNormLpcd: 135,
      powerFactorMin: 0.90,
      criticalPowerUptimePercent: 99.5,
    },
    focusAreas: [
      'Hostel morning bath peak vs. Classroom lecture hours',
      'Pumping water to Overhead Tanks (OHTs) during night-time discount hours',
      'Preventing lab machinery and autoclave electrical overloads',
      'Avoiding electricity board penalties on power factor',
    ],
  },

  hospital: {
    id: 'hospital',
    name: 'Multi-Specialty Hospital / Healthcare',
    category: 'Critical Healthcare Infrastructure',
    badge: '🏥 Healthcare / Hospital',
    icon: '🏥',
    scaleTag: 'OTs, ICUs, Wards & Medical Equipment',
    plainDescription: 'Designed for multi-specialty hospitals, medical colleges, and clinics. Prioritizes zero-interruption life support, ICU and Operation Theatre (OT) power stability, sterile water supplies, and backup generator readiness.',
    persona: {
      adminTitle: 'Medical Superintendent & Hospital Director',
      leadEngineer: 'Head of Biomedical Engineering & Facilities',
      groundTeam: 'Critical Power Shift Technician & Medical Gas/Plumbing Lead',
      laymanTarget: 'Guarantees that patient life-support, ventilators, and surgical equipment never suffer power drops, and ensures clean continuous water pressure for patient care.',
    },
    tariff: {
      categoryName: 'HT-Hospital / Essential Services',
      baseRatePerKwh: 8.20,
      peakSurcharge: 0.15,
      offPeakRebate: 0.15,
      contractedDemandKva: 800,
      pfThreshold: 0.92,
      waterTankerCostPer6000L: 1600,
    },
    benchmarks: {
      waterNormLpcd: 450, // 340-450 LPCD per bed (NBC 2016)
      powerFactorMin: 0.92,
      criticalPowerUptimePercent: 99.999,
    },
    focusAreas: [
      'Zero-voltage-drop guarantee for Operation Theatres and ICU ventilators',
      'Emergency Diesel Generator (DG) standby sync & uninterrupted UPS health',
      'Constant water pressure (3.0-4.0 bar) for kidney dialysis and sterilization',
      'Continuous chiller cooling for medical refrigeration and vaccine storage',
    ],
  },

  industrial_powerhouse: {
    id: 'industrial_powerhouse',
    name: 'Industrial Plant / Big Power House / Substation',
    category: 'Heavy Manufacturing & Power Utilities',
    badge: '🏭 Industrial / Power House',
    icon: '🏭',
    scaleTag: 'Substations, Motor Centers & Cooling Towers',
    plainDescription: 'Designed for heavy manufacturing plants, captive power houses, substations, and industrial complexes with high-voltage electricity lines, massive motor drives, and continuous boiler/cooling water loops.',
    persona: {
      adminTitle: 'Plant Head & Vice President (Manufacturing)',
      leadEngineer: 'Chief Electrical Inspector & Energy Manager (BEE Certified)',
      groundTeam: 'Substation Control Room Engineer & Maintenance Fitters',
      laymanTarget: 'Stops production downtime, eliminates massive industrial demand surcharges, and ensures high-voltage machinery operates safely without overheating.',
    },
    tariff: {
      categoryName: 'HT-1 Industrial Heavy Consumer (11kV / 33kV)',
      baseRatePerKwh: 9.20,
      peakSurcharge: 0.25,
      offPeakRebate: 0.20,
      contractedDemandKva: 2500,
      pfThreshold: 0.95,
      waterTankerCostPer6000L: 1800,
    },
    benchmarks: {
      waterNormLpcd: 250,
      powerFactorMin: 0.95,
      criticalPowerUptimePercent: 99.9,
    },
    focusAreas: [
      'Maximum Demand (kVA) curtailment to avoid huge electricity board penalties',
      'Motor efficiency and automatic capacitor bank health to stop energy waste',
      'Cooling tower, boiler water supply, and high-pressure steam line safety',
      'Three-phase electrical balance to protect large industrial transformers',
    ],
  },

  commercial_it: {
    id: 'commercial_it',
    name: 'Commercial IT Park / Tech Campus',
    category: 'Corporate High-Rise & Tech Parks',
    badge: '🏢 IT Park / Tech Hub',
    icon: '🏢',
    scaleTag: 'Office Towers, Server Rooms & HVAC Chillers',
    plainDescription: 'Designed for commercial IT/ITES business parks, corporate headquarters, and multi-tenant tech towers. Focuses on server room UPS reliability, central air conditioning (chillers), and office hours energy savings.',
    persona: {
      adminTitle: 'VP Real Estate & Workplace Experience',
      leadEngineer: 'Senior Facilities Operations Manager',
      groundTeam: 'BMS (Building Management System) Lead & MEP Technicians',
      laymanTarget: 'Keeps corporate tenant workspaces comfortable and servers running 24/7 while cutting expensive peak-hour air conditioning electricity costs.',
    },
    tariff: {
      categoryName: 'HT-Commercial IT/ITES Park',
      baseRatePerKwh: 9.80,
      peakSurcharge: 0.20,
      offPeakRebate: 0.15,
      contractedDemandKva: 1200,
      pfThreshold: 0.92,
      waterTankerCostPer6000L: 1500,
    },
    benchmarks: {
      waterNormLpcd: 45,
      powerFactorMin: 0.92,
      criticalPowerUptimePercent: 99.95,
    },
    focusAreas: [
      'Server room power security and precision air conditioning',
      'HVAC central chiller plant power efficiency during hot afternoon peaks',
      'Tenant electricity billing accuracy and green ESG compliance',
      'Turning down ventilation and lighting automatically on empty floors',
    ],
  },

  residential_society: {
    id: 'residential_society',
    name: 'Residential Society / Villa / Single House',
    category: 'Gated Residential Community',
    badge: '🏡 Residential / Housing Society',
    icon: '🏡',
    scaleTag: 'Apartment Towers, Lifts, Clubhouses & Villas',
    plainDescription: 'Designed for residential apartment complexes, gated housing societies, and independent houses. Focuses on common area electricity (lifts, streetlights), overhead tank overflow prevention, and domestic water tanker expenses.',
    persona: {
      adminTitle: 'Resident Welfare Association (RWA) President / Secretary',
      leadEngineer: 'Society Maintenance Supervisor',
      groundTeam: 'Society Electrician & Domestic Plumber',
      laymanTarget: 'Keeps society maintenance fees low by stopping water tank overflows, cutting common area electricity waste, and managing backup generator diesel bills.',
    },
    tariff: {
      categoryName: 'LT-Domestic Slab Tariff (State DISCOM)',
      baseRatePerKwh: 6.80,
      peakSurcharge: 0.10,
      offPeakRebate: 0.10,
      contractedDemandKva: 250,
      pfThreshold: 0.85,
      waterTankerCostPer6000L: 1400,
    },
    benchmarks: {
      waterNormLpcd: 150,
      powerFactorMin: 0.88,
      criticalPowerUptimePercent: 98.5,
    },
    focusAreas: [
      'Stopping roof overhead water tanks from overflowing onto parking lots',
      'Lowering electricity used by water pumps, elevators, and corridor lighting',
      'Optimizing backup generator diesel costs during local power cuts',
      'Tracking daily water tanker purchases during summer shortages',
    ],
  },
};

/** Active profile in memory (default: college_campus) */
let activeProfileId = 'college_campus';

function getActiveProfile() {
  return PROFILES[activeProfileId] || PROFILES.college_campus;
}

function setActiveProfile(profileId) {
  if (PROFILES[profileId]) {
    activeProfileId = profileId;
    return PROFILES[activeProfileId];
  }
  throw new Error(`Unknown organization profile '${profileId}'. Valid: ${Object.keys(PROFILES).join(', ')}`);
}

function listProfiles() {
  return Object.values(PROFILES).map(p => ({
    ...p,
    isActive: p.id === activeProfileId,
  }));
}

module.exports = {
  PROFILES,
  getActiveProfile,
  setActiveProfile,
  listProfiles,
};
