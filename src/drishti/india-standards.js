/**
 * india-standards.js
 * ─────────────────────────────────────────────────────────────
 * Indian Central Electricity Authority (CEA), BIS, CPHEEO,
 * and state DISCOM regulatory standards, tariffs, and cost models.
 * Includes plain-language non-technical analogies and metrics.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * Indian Grid Tolerances (as per CEA Grid Standards & BIS IS 12360)
 */
const GRID_STANDARDS = {
  NOMINAL_VOLTAGE_SINGLE_PHASE: 230, // Volts
  NOMINAL_VOLTAGE_THREE_PHASE: 415,  // Volts
  VOLTAGE_TOLERANCE_PERCENT: 6.0,    // ±6% (216.2V - 243.8V)
  MIN_VOLTAGE: 216.2,
  MAX_VOLTAGE: 243.8,

  NOMINAL_FREQUENCY_HZ: 50.0,
  FREQUENCY_TOLERANCE_HZ: 0.5,       // 49.5 Hz - 50.5 Hz (IEGC operation band 49.90 - 50.05)
  MIN_FREQUENCY: 49.5,
  MAX_FREQUENCY: 50.5,

  // DISCOM Power Factor thresholds
  BENCHMARK_POWER_FACTOR: 0.90,     // Below this, state DISCOM applies billing penalties
  HIGH_EFFICIENCY_PF: 0.95,         // Above this, state DISCOM gives cashback rebate
};

/**
 * Default Indian Utility Tariffs (Institutional / Commercial / HT-1)
 */
const DEFAULT_TARIFFS = {
  // Base electricity tariff (₹/kWh)
  BASE_RATE_PER_KWH: 8.50,

  // Time-of-Day (ToD) tariff multipliers
  TOD_PEAK_SURCHARGE: 0.20,       // +20% during peak hours (18:00 - 22:00 & 06:00 - 10:00)
  TOD_OFF_PEAK_REBATE: 0.15,      // -15% rebate during night hours (22:00 - 06:00)

  // Maximum Demand (MD) charges
  MD_CHARGE_PER_KVA: 350.0,       // Monthly fixed charge per kVA of sanctioned load
  MD_PENALTY_MULTIPLIER: 1.50,    // 150% penalty on demand exceeding contracted limit

  // DISCOM Power Factor penalty/rebate rates
  PF_PENALTY_PER_STEP: 0.015,     // 1.5% surcharge per 0.01 fall below 0.90
  PF_REBATE_PER_STEP: 0.005,      // 0.5% incentive per 0.01 rise above 0.95 up to 1.0

  // Water Tariffs & Tanker Replacement Valuations
  MUNICIPAL_WATER_PER_KL: 18.0,   // ₹18 per 1,000 Litres (kL)
  TANKER_COST_PER_6000L: 1500.0,  // ₹1,500 per 6,000L tanker (typical Indian urban cost)
  TANKER_COST_PER_LITRE: 0.25,    // ₹0.25 per Litre
};

/**
 * Format a number as Indian Currency (₹) with Lakh/Crore grouping.
 * e.g., 145000 -> ₹1,45,000
 * @param {number} amount
 * @param {boolean} includeDecimals
 * @returns {string}
 */
function formatINR(amount, includeDecimals = false) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0';
  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);

  let formatted;
  if (includeDecimals) {
    formatted = absAmount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else {
    formatted = Math.round(absAmount).toLocaleString('en-IN');
  }

  return `${isNegative ? '-' : ''}₹${formatted}`;
}

/**
 * Format timestamp in Indian Standard Time (IST, UTC+5:30)
 * @param {Date|string|number} date
 * @returns {string}
 */
function formatIST(date = new Date()) {
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: true,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Check if current IST hour is in ToD Peak, Off-Peak, or Normal window.
 * Peak: 06:00-10:00 & 18:00-22:00 IST (+20% surcharge)
 * Off-Peak: 22:00-06:00 IST (-15% green rebate)
 * Normal: 10:00-18:00 IST
 * @param {Date} [now]
 * @returns {{ window: 'PEAK'|'OFF_PEAK'|'NORMAL', multiplier: number, label: string, nonTechTip: string }}
 */
function getToDSlot(now = new Date()) {
  const d = new Date(now);
  const istHours = (d.getUTCHours() + 5 + Math.floor((d.getUTCMinutes() + 30) / 60)) % 24;

  if (istHours >= 22 || istHours < 6) {
    return {
      window: 'OFF_PEAK',
      multiplier: 1 - DEFAULT_TARIFFS.TOD_OFF_PEAK_REBATE,
      label: 'Off-Peak Night Rebate (-15%)',
      nonTechTip: 'Electricity is discounted by 15% right now. Perfect time for water pumping and heavy equipment.',
    };
  } else if ((istHours >= 6 && istHours < 10) || (istHours >= 18 && istHours < 22)) {
    return {
      window: 'PEAK',
      multiplier: 1 + DEFAULT_TARIFFS.TOD_PEAK_SURCHARGE,
      label: 'Peak DISCOM Surcharge (+20%)',
      nonTechTip: 'Electricity is 20% more expensive right now due to peak grid demand. Avoid non-essential heavy loads.',
    };
  }
  return {
    window: 'NORMAL',
    multiplier: 1.0,
    label: 'Normal Day Tariff (Standard)',
    nonTechTip: 'Standard electricity rate is currently active.',
  };
}

/**
 * Calculate DISCOM monthly power factor penalty or rebate projection with plain-language layman explanations.
 * @param {number} currentPF - e.g. 0.82
 * @param {number} totalMonthlyKwh - estimated monthly kWh
 * @param {number} [ratePerKwh]
 * @returns {{ status: 'PENALTY'|'REBATE'|'NOMINAL', percentDelta: number, monthlyAmountINR: number, explanation: string, laymanAnalogy: string }}
 */
function calculatePFPenalty(currentPF, totalMonthlyKwh = 50000, ratePerKwh = DEFAULT_TARIFFS.BASE_RATE_PER_KWH) {
  const baseMonthlyEnergyCharge = totalMonthlyKwh * ratePerKwh;

  if (currentPF < GRID_STANDARDS.BENCHMARK_POWER_FACTOR) {
    const stepsBelow = (GRID_STANDARDS.BENCHMARK_POWER_FACTOR - currentPF) * 100;
    const penaltyPercent = Math.min(stepsBelow * (DEFAULT_TARIFFS.PF_PENALTY_PER_STEP * 100), 30);
    const penaltyAmount = (penaltyPercent / 100) * baseMonthlyEnergyCharge;

    return {
      status: 'PENALTY',
      percentDelta: parseFloat(penaltyPercent.toFixed(1)),
      monthlyAmountINR: Math.round(penaltyAmount),
      explanation: `Power factor of ${currentPF.toFixed(2)} is below DISCOM 0.90 threshold. Attracts a ${penaltyPercent.toFixed(1)}% surcharge on energy charges (~${formatINR(penaltyAmount)}/month).`,
      laymanAnalogy: `Like buying a soda with 30% useless foam: electrical motors are wasting power as heat, and the Electricity Board is penalizing your monthly bill by approx. ${formatINR(penaltyAmount)}.`,
    };
  } else if (currentPF >= GRID_STANDARDS.HIGH_EFFICIENCY_PF) {
    const stepsAbove = (Math.min(currentPF, 1.0) - GRID_STANDARDS.HIGH_EFFICIENCY_PF) * 100;
    const rebatePercent = stepsAbove * (DEFAULT_TARIFFS.PF_REBATE_PER_STEP * 100);
    const rebateAmount = (rebatePercent / 100) * baseMonthlyEnergyCharge;

    return {
      status: 'REBATE',
      percentDelta: parseFloat(rebatePercent.toFixed(1)),
      monthlyAmountINR: Math.round(rebateAmount),
      explanation: `High power factor of ${currentPF.toFixed(2)} qualifies for DISCOM high-efficiency rebate of ${rebatePercent.toFixed(1)}% (~${formatINR(rebateAmount)}/month savings).`,
      laymanAnalogy: `Outstanding electrical health! Equipment is converting nearly 100% of power into useful work, earning a cashback discount of ${formatINR(rebateAmount)}/month from your Electricity Board.`,
    };
  }

  return {
    status: 'NOMINAL',
    percentDelta: 0,
    monthlyAmountINR: 0,
    explanation: `Power factor of ${currentPF.toFixed(2)} is in compliance with state electricity regulations.`,
    laymanAnalogy: `Electrical efficiency is in the acceptable normal zone. No extra penalties applied.`,
  };
}

module.exports = {
  GRID_STANDARDS,
  DEFAULT_TARIFFS,
  formatINR,
  formatIST,
  getToDSlot,
  calculatePFPenalty,
};
