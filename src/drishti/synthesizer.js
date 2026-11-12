/**
 * synthesizer.js
 * ─────────────────────────────────────────────────────────────
 * Drishti — Executive Facility & Trend Intelligence Synthesizer.
 *
 * Implements a dual-engine architecture:
 *  1. Google Gemini GenAI Gateway (when GEMINI_API_KEY is configured)
 *     Provides deep contextual reasoning, plain-language synthesis,
 *     and interactive decision support for non-technical managers.
 *  2. Deterministic Indian Executive Synthesizer (Zero-config fallback)
 *     Provides 100% offline, guaranteed high-quality executive briefings
 *     with ₹ cost figures, DISCOM rules, and layman action playbooks.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const engine = require('../simulator/engine');
const { analyzeFacility } = require('./analytics');
const { formatINR } = require('./india-standards');
const { getActiveProfile } = require('./org-profiles');

let runtimeApiKey = process.env.GEMINI_API_KEY || '';
let runtimeModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// Conversational in-memory history
const conversationHistory = [];

function setConfig(cfg = {}) {
  if (cfg.apiKey !== undefined) runtimeApiKey = cfg.apiKey.trim();
  if (cfg.model !== undefined) runtimeModel = cfg.model.trim();
}

function getConfig() {
  const prov = runtimeApiKey ? 'Google Gemini AI' : 'Drishti Local Trend Synthesizer';
  return {
    featureName: 'Drishti: Executive Facility & Trend Intelligence',
    hasGeminiKey: Boolean(runtimeApiKey),
    activeModel: runtimeModel,
    model: runtimeModel,
    activeProvider: prov,
    provider: prov,
    organizationProfile: getActiveProfile().id,
  };
}

/**
 * Generate a deterministic plain-language executive synthesis for non-technical stakeholders.
 * @param {Object} analytics
 * @param {Object} [options]
 * @returns {string} Plain-language markdown synthesis
 */
function generateDeterministicSynthesis(analytics, options = {}) {
  const { organization, health, economics, anomalies, improvements, trendInsights, wasteIntelligence } = analytics;
  const p = organization.persona;
  const operator = options.operator;
  const domains = operator ? operator.domains : ['*'];
  const showAll = domains.includes('*') || domains.length > 2;
  const showPower = showAll || domains.includes('power');
  const showWater = showAll || domains.includes('water');
  const showWaste = showAll || domains.includes('waste');

  let text = `### 🇮🇳 Drishti Executive Intelligence Briefing — ${organization.name}\n`;
  const roleTitle = operator ? `${operator.name} (${operator.badge})` : p.adminTitle;
  text += `**Executive Briefing for:** **${roleTitle}** | *Status as of ${analytics.istFormattedTime} (IST)*\n\n`;

  // Status & Verdict in layman terms
  text += `**Current Condition: ${health.score}% (${health.status})**\n`;
  text += `*${health.laymanVerdict}*\n\n`;

  // Energy & Electricity in plain terms
  if (showPower) {
    text += `⚡ **Electricity Consumption & Hourly Cost:**\n`;
    text += `The entire facility is currently drawing **${economics.totalPowerKw} kW** of electrical power. Under your current **${organization.tariffCategory}** tariff, this costs approx. **${economics.hourlyEnergyCostFormatted} every hour** (${economics.todLabel}).\n`;
    text += `💡 *${economics.nonTechTip}*\n\n`;

    // Power Factor Analysis in plain terms
    const pf = economics.powerFactor;
    if (pf.evaluation.status === 'PENALTY') {
      text += `⚠️ **Electricity Board Penalty Warning:**\n`;
      text += `Your electrical equipment is wasting power as heat (Power Factor is **${pf.average}** vs mandatory 0.90 standard). **${pf.evaluation.laymanAnalogy}**\n\n`;
    } else if (pf.evaluation.status === 'REBATE') {
      text += `✅ **Electricity Board Efficiency Rebate:**\n`;
      text += `Your electrical equipment is running at peak efficiency (Power Factor is **${pf.average}**), qualifying your facility for a **${formatINR(pf.evaluation.monthlyAmountINR)}/month cashback rebate** on your bill.\n\n`;
    }
  }

  // Water Security in plain terms
  if (showWater) {
    const ww = economics.waterWaste;
    const wi = analytics.waterIntelligence;

    if (wi?.overflowingTanks?.length > 0) {
      const ot = wi.overflowingTanks[0];
      text += `🌊 **CRITICAL TANK OVERFLOW IN PROGRESS:**\n`;
      text += `Overhead tank **${ot.label}** is 100% full and actively overflowing at **${ot.overflow_rate_lpm} L/min**! Water is cascading from the terrace. Switch off the pump motor immediately!\n\n`;
    } else if (wi?.imminentOverflows?.length > 0) {
      const io = wi.imminentOverflows[0];
      text += `⏱️ **PUMP OVERFLOW PREDICTION (Time-to-Overflow):**\n`;
      text += `Water pump is currently RUNNING on **${io.label}** (Tank fill: ${io.level}%). AI predicts **tank will overflow in ${io.eta_overflow_formatted}** (Expected at **${io.expected_overflow_time}**). Auto-cutoff recommended at 95% to prevent terrace spillage.\n\n`;
    }

    if (wi?.temporalLeakAnomalies?.length > 0) {
      const ta = wi.temporalLeakAnomalies[0];
      text += `🚨 **AI TEMPORAL LEAK INTELLIGENCE (Sudden Drain Detected):**\n`;
      text += `Temporal memory check: **${ta.label}** was at **${ta.level_2h_ago}% 2 hours ago**, but has abruptly crashed to **${ta.current_level}%** (an anomalous **${ta.delta_drop}% drop** vs normal 15% diurnal drain). This strongly indicates an underground rupture or stuck flush line!\n\n`;
    }

    if (anomalies.activeLeaks.length > 0) {
      text += `💧 **Water Leakage & Tanker Loss Alert:**\n`;
      text += `Active water leaks were detected in **${anomalies.activeLeaks.length} location(s)** (${anomalies.activeLeaks.map(l => `${l.label}: ${l.flow_lpm} LPM`).join(', ')}). `;
      text += `Clean water is pouring away at **${ww.hourlyLossLitres.toLocaleString('en-IN')} Litres every hour** — this is equal to wasting **${ww.tankersLostPerHour} commercial water tankers per hour** (~${ww.hourlyLeakCostFormatted}/hr in tanker replacement cost).\n\n`;
    } else {
      text += `💧 **Water Storage & Security:**\n`;
      text += `All water storage tanks are securely filled at an average of **${trendInsights.waterTrend.averageTankLevel}%**. Total water used today is **${economics.totalLitresToday.toLocaleString('en-IN')} Litres**. No pipe ruptures or hidden leaks active.\n\n`;
    }
  }

  // Solid Waste Management in plain terms
  if (showWaste && wasteIntelligence) {
    text += `♻️ **Solid Waste & Sanitation Operations:**\n`;
    if (wasteIntelligence.fireHazards?.length > 0) {
      text += `🔥 **EMERGENCY THERMAL FIRE HAZARD IN CONTAINER:**\n`;
      text += `Smoldering decomposition detected in **${wasteIntelligence.fireHazards[0].label}** (${wasteIntelligence.fireHazards[0].temp}°C)! Douse with fire extinguisher immediately!\n\n`;
    } else if (wasteIntelligence.overflowingBins?.length > 0) {
      text += `🗑️ **SOLID WASTE OVERFLOW WARNING:**\n`;
      text += `**${wasteIntelligence.overflowingBins.length} receptacle(s)** (${wasteIntelligence.overflowingBins.map(b => b.label).join(', ')}) are completely full and spilling over. Sanitation truck pickup required immediately.\n\n`;
    } else if (wasteIntelligence.compactorJams?.length > 0) {
      text += `⚙️ **HYDRAULIC COMPACTOR MOTOR JAM:**\n`;
      text += `Compactor station **${wasteIntelligence.compactorJams[0].label}** has stalled due to mechanical obstruction. Clear ram before motor overheating.\n\n`;
    } else {
      text += `Campus sanitation is optimal across **${wasteIntelligence.monitoredReceptaclesCount} stations** (Avg fill: **${wasteIntelligence.averageBinFillPercent}%**, Total waste: **${wasteIntelligence.totalWasteKg} kg** today). Swachh status: **${wasteIntelligence.swachhCompliance}**.\n\n`;
    }
  }

  // Prescriptive Playbook ("How It Can Be Improved")
  text += `#### 💡 How Can It Be Improved? (Actionable Steps for Non-Technical Managers)\n`;
  const relevantImprovements = improvements.filter(imp => {
    if (showAll) return true;
    if (imp.domain === 'waste' && showWaste) return true;
    if (imp.domain === 'power' && showPower) return true;
    if (imp.domain === 'water' && showWater) return true;
    if (!imp.domain && showPower) return true;
    return false;
  });

  if (relevantImprovements.length === 0) {
    text += `• All monitored subsystems in your authorized scope are running normally within Indian safety and efficiency limits. No interventions needed right now.\n`;
  } else {
    for (let i = 0; i < Math.min(relevantImprovements.length, 3); i++) {
      const imp = relevantImprovements[i];
      text += `**${i + 1}. [${imp.horizon}] ${imp.icon || '⚡'} ${imp.title}**\n`;
      text += `   • **What is happening:** ${imp.laymanProblem}\n`;
      text += `   • **Money Impact:** ${imp.financialImpact}\n`;
      text += `   • **What to do:** ${imp.action}\n\n`;
    }
  }

  return text;
}

/**
 * Call Google Gemini API
 */
async function callGemini(prompt, systemInstruction = '') {
  if (!runtimeApiKey) throw new Error('GEMINI_API_KEY is not configured');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${runtimeModel}:generateContent?key=${runtimeApiKey}`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1200,
    },
  };

  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API returned status ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No content returned from Gemini model');
  return text;
}

/**
 * Get complete plain-language synthesis (Gemini if key set, else Fallback).
 * @param {Object} [options] - { operator, orgId }
 * @returns {Promise<{ synthesis: string, analytics: Object, provider: string }>}
 */
async function getSynthesis(options = {}) {
  const { PROFILES, getActiveProfile } = require('./org-profiles');
  const orgProfile = (options.orgId && PROFILES[options.orgId]) ? PROFILES[options.orgId] : getActiveProfile();
  const analytics = analyzeFacility(orgProfile);

  if (runtimeApiKey) {
    try {
      const prompt = `Here is the current real-time telemetry analytics for an Indian ${analytics.organization.name} facility:
${JSON.stringify(analytics, null, 2)}

Provide an executive plain-language decision support briefing for the ${analytics.organization.persona.adminTitle}.
CRITICAL INSTRUCTION:
Write in simple, conversational Indian English that a NON-TECHNICAL person (e.g. university registrar, society secretary, or medical director) can immediately understand.
Explain technical terms with everyday real-world analogies (e.g. explain power factor as wasted foam in a drink, explain water leaks in private water tanker equivalents, explain waste bins in municipal truckloads).
Include:
1. Plain-Language Verdict: How is the facility doing overall right now?
2. Electricity & Tariff Insight: How much power is being drawn, hourly cost in ₹, and whether we are in peak expensive hours or discount night hours.
3. Power Factor & DISCOM Penalties: Are we wasting electricity and will the Electricity Board charge extra penalty fees?
4. Water Security: Are tanks filled, and is clean water being lost to leaks (in Litres and tanker numbers)?
5. Solid Waste & Sanitation: Status of compactors, smart bins, and Swachh hygiene compliance.
6. How Can It Be Improved: 3 direct, practical action steps with exact instructions for the maintenance team.`;

      const systemInstruction = `You are Drishti, an expert Executive Facility & Trend Intelligence Advisor specializing in Indian institutional, hospital, commercial, and residential facilities. Explain complex technical sensor data in simple, clear, actionable terms using ₹ currency and everyday Indian context.`;

      const genAiText = await callGemini(prompt, systemInstruction);
      return {
        synthesis: genAiText,
        analytics,
        provider: 'Google Gemini AI',
      };
    } catch (err) {
      console.warn('[drishti] Gemini API call failed, using local synthesizer:', err.message);
    }
  }

  // Deterministic Fallback
  return {
    synthesis: generateDeterministicSynthesis(analytics, options),
    analytics,
    provider: 'Drishti Local Trend Synthesizer',
  };
}

/**
 * Interactive Q&A with Drishti Advisor.
 * @param {string} userQuery
 * @param {Object} [options] - { operator, orgId }
 * @returns {Promise<{ reply: string, provider: string, domainScope?: string[] }>}
 */
async function chat(userQuery, options = {}) {
  const { PROFILES, getActiveProfile } = require('./org-profiles');
  const profile = (options.orgId && PROFILES[options.orgId]) ? PROFILES[options.orgId] : getActiveProfile();
  const analytics = analyzeFacility(profile);
  const econ = analytics.economics;
  const anomalies = analytics.anomalies;
  const operator = options.operator;

  // ── Operator Domain Scope Enforcement ──────────────────────────────────────
  if (operator && operator.role !== 'admin' && !operator.domains.includes('*')) {
    const q = userQuery.toLowerCase();
    const isPowerOp = operator.domains.includes('power') && operator.domains.length === 1;
    const isWaterOp = operator.domains.includes('water') && operator.domains.length === 1;
    const isWasteOp = operator.domains.includes('waste') && operator.domains.length === 1;

    const mentionsPower = /power|electricity|voltage|pf|power factor|kw|tariff|discom|bill|substation|transformer|load/.test(q);
    const mentionsWater = /water|tank|leak|pump|burst|tanker|overflow|hydraulic|pressure|drain/.test(q);
    const mentionsWaste = /waste|garbage|bin|compactor|trash|refuse|odor|methane|swachh|sanitation|compost/.test(q);

    // If power specialist asks about water or waste
    if (isPowerOp && (mentionsWater || mentionsWaste) && !mentionsPower) {
      return {
        reply: `### 🔒 Access Restricted (Domain Scope Mismatch)\n\n` +
          `You are signed in as **${operator.name}** with operational clearance restricted to the **⚡ Power & Electrical Systems** domain for **${profile.name}**.\n\n` +
          `Under administrator policy, you do not have permission to query Water Utility or Waste Management telemetry. Please contact your **Root Administrator** (${profile.persona.adminTitle}) if you require cross-domain module privileges.`,
        provider: 'Drishti Scope Policy Enforcement',
        domainScope: operator.domains,
        operator: operator.name,
        orgId: profile.id,
      };
    }

    // If water specialist asks about power or waste
    if (isWaterOp && (mentionsPower || mentionsWaste) && !mentionsWater) {
      return {
        reply: `### 🔒 Access Restricted (Domain Scope Mismatch)\n\n` +
          `You are signed in as **${operator.name}** with operational clearance restricted to the **💧 Water & Hydraulic Systems** domain for **${profile.name}**.\n\n` +
          `Under administrator policy, you do not have permission to query Electrical Grid or Waste Management telemetry. Please contact your **Root Administrator** (${profile.persona.adminTitle}) if you require cross-domain module privileges.`,
        provider: 'Drishti Scope Policy Enforcement',
        domainScope: operator.domains,
        operator: operator.name,
        orgId: profile.id,
      };
    }

    // If waste specialist asks about power or water
    if (isWasteOp && (mentionsPower || mentionsWater) && !mentionsWaste) {
      return {
        reply: `### 🔒 Access Restricted (Domain Scope Mismatch)\n\n` +
          `You are signed in as **${operator.name}** with operational clearance restricted to the **♻️ Sanitation & Waste Management** domain for **${profile.name}**.\n\n` +
          `Under administrator policy, you do not have permission to query Electrical Grid or Water Utility telemetry. Please contact your **Root Administrator** (${profile.persona.adminTitle}) if you require cross-domain module privileges.`,
        provider: 'Drishti Scope Policy Enforcement',
        domainScope: operator.domains,
        operator: operator.name,
        orgId: profile.id,
      };
    }
  }

  if (runtimeApiKey) {
    try {
      const systemInstruction = `You are Drishti, an intelligent Executive Facility & Trend Intelligence Advisor for ${profile.name} (${profile.persona.adminTitle}).
Answer in plain, simple, jargon-free Indian English suitable for non-technical executives and administrators.
Quote costs in Indian Rupees (₹), reference IST time, use everyday analogies (water tankers, vehicle efficiency, electricity board tariffs, municipal garbage truckloads), and provide practical directives for ${profile.persona.groundTeam}.`;

      const contextPrompt = `REAL-TIME TELEMETRY CONTEXT (${profile.name}):
${JSON.stringify({
  organization: profile.name,
  health: analytics.health,
  economics: analytics.economics,
  trendInsights: analytics.trendInsights,
  waterIntelligence: analytics.waterIntelligence,
  wasteIntelligence: analytics.wasteIntelligence,
  anomalies: analytics.anomalies,
  improvements: analytics.improvements,
}, null, 2)}

USER QUESTION: "${userQuery}"

Provide a crystal-clear, non-technical, helpful response.`;

      const reply = await callGemini(contextPrompt, systemInstruction);

      conversationHistory.push({ role: 'user', content: userQuery });
      conversationHistory.push({ role: 'assistant', content: reply });
      if (conversationHistory.length > 10) conversationHistory.splice(0, 2);

      return { reply, provider: 'Google Gemini AI' };
    } catch (err) {
      console.warn('[drishti] Gemini chat error, using local fallback:', err.message);
    }
  }

  // Deterministic Layman Q&A Fallback
  const q = userQuery.toLowerCase();
  let reply = '';

  if (q.includes('power factor') || q.includes('pf') || q.includes('discom') || q.includes('penalty') || q.includes('electricity bill')) {
    const pf = econ.powerFactor;
    reply = `### ⚡ Electricity Quality & Monthly Bill Check\n\n` +
      `• **What is Power Factor?** Think of it like a vehicle's mileage. A score of 0.90 to 1.0 means your electrical equipment converts nearly all power into work. Below 0.90 means electricity is being wasted as heat.\n` +
      `• **Current Score:** **${pf.average}** (Benchmark required by Electricity Board: **${profile.tariff.pfThreshold || 0.90}**)\n` +
      `• **Financial Impact:** ${pf.evaluation.status === 'PENALTY' ? `⚠️ **Penalty Alert!** Adding approx. **${formatINR(pf.evaluation.monthlyAmountINR)}** extra surcharge to this month's bill.` : pf.evaluation.status === 'REBATE' ? `✅ **Cashback Rebate!** Earning approx. **${formatINR(pf.evaluation.monthlyAmountINR)}/month** discount on your bill.` : 'Operating in normal compliance range.'}\n` +
      `• **How to Fix It:** Tell ${profile.persona.groundTeam} to check the automatic capacitor bank (APFC) at the main switchboard and switch on capacitors to eliminate the penalty.`;
  } else if (q.includes('water') || q.includes('leak') || q.includes('tanker')) {
    const ww = econ.waterWaste;
    if (anomalies.activeLeaks.length > 0) {
      reply = `### 💧 Water Leakage & Tanker Loss Report\n\n` +
        `• **Current Situation:** Water is leaking at **${ww.hourlyLossLitres.toLocaleString('en-IN')} Litres every hour** across ${anomalies.activeLeaks.length} location(s).\n` +
        `• **Equivalent Waste:** Equal to throwing away **${ww.tankersLostPerDay} full commercial water tankers every day**.\n` +
        `• **Money Cost:** Costing approx. **${ww.hourlyLeakCostFormatted} every hour** in replacement water tanker expenses.\n` +
        `• **Where is it leaking?** ${anomalies.activeLeaks.map(l => `**${l.label}** (${l.flow_lpm} L/min)`).join(', ')}.\n` +
        `• **What to do:** Close the supply valve to the leaking tank and send the plumber to replace the float valve or seal the pipe.`;
    } else {
      reply = `### 💧 Water Status: 100% Secure\n\n` +
        `• All water tanks are filled to an average of **${analytics.trendInsights.waterTrend.averageTankLevel}%** capacity.\n` +
        `• Total water consumed today: **${econ.totalLitresToday.toLocaleString('en-IN')} Litres**.\n` +
        `• No hidden leaks or burst pipes detected anywhere on the premises.`;
    }
  } else if (q.includes('waste') || q.includes('bin') || q.includes('compactor') || q.includes('garbage') || q.includes('odor') || q.includes('swachh')) {
    const wst = analytics.wasteIntelligence;
    if (wst?.fireHazards?.length > 0) {
      const fh = wst.fireHazards[0];
      reply = `### 🔥 CRITICAL THERMAL RISK IN WASTE CONTAINER\n\n` +
        `• **Receptacle:** **${fh.label}**\n` +
        `• **Temperature:** **${fh.temp}°C** (Ambient is 28°C)\n` +
        `• **Status:** Smoldering organic or chemical decomposition. Fire hazard in progress!\n` +
        `• **Immediate Action:** Douse container with dry powder fire extinguisher and isolate container away from building walls.`;
    } else if (wst?.overflowingBins?.length > 0) {
      reply = `### 🗑️ Solid Waste Overflow Alert\n\n` +
        `• **Current Situation:** **${wst.overflowingBins.length} waste station(s)** are currently 100% full and overflowing.\n` +
        `• **Affected Locations:** ${wst.overflowingBins.map(b => `**${b.label}** (${b.fill}% full, ${b.weight} kg)`).join(', ')}.\n` +
        `• **Swachh Status:** Action required — risk of campus hygiene citations and pest breeding.\n` +
        `• **Immediate Action:** Dispatch campus sanitation truck to empty receptacles and transport waste to compost yard.`;
    } else if (wst?.compactorJams?.length > 0) {
      reply = `### ⚙️ Hydraulic Compactor Jam Alert\n\n` +
        `• **Station:** **${wst.compactorJams[0].label}**\n` +
        `• **Status:** Motor locked on oversized solid waste. Compaction cycle halted.\n` +
        `• **Immediate Action:** Shut down 415V feeder breaker, operate reverse jog lever to free the ram, and remove blocking debris.`;
    } else {
      reply = `### ♻️ Solid Waste & Sanitation Status: Optimal\n\n` +
        `• **Receptacles Monitored:** **${wst?.monitoredReceptaclesCount || 4} smart bins & compactor stations** across ${profile.name}.\n` +
        `• **Average Fill Level:** **${wst?.averageBinFillPercent || 48}%** across all campus bins.\n` +
        `• **Total Waste Generated Today:** **${wst?.totalWasteKg || 120} kg**.\n` +
        `• **Compactor Fleet:** All compactor hydraulics ready. No motor jams.\n` +
        `• **Swachh Compliance:** **${wst?.swachhCompliance || 'COMPLIANT'}** — zero uncontained litter or overflowing refuse.`;
    }
  } else if (q.includes('overflow') || q.includes('pump') || q.includes('refill') || q.includes('fill') || q.includes('when')) {
    const wi = analytics.waterIntelligence;
    if (wi?.overflowingTanks?.length > 0) {
      reply = `### 🌊 ACTIVE TANK OVERFLOW WARNING\n\n` +
        `• **Status:** Overhead tank is 100% full and overflowing at **${wi.overflowingTanks[0].overflow_rate_lpm} L/min**!\n` +
        `• **Action Required:** Turn OFF water pump immediately to prevent terrace flooding and structural seepage.\n` +
        `• **Location:** ${wi.overflowingTanks.map(t => t.label).join(', ')}`;
    } else if (wi?.imminentOverflows?.length > 0) {
      const io = wi.imminentOverflows[0];
      reply = `### ⏱️ AI Water Refill & Overflow Prediction\n\n` +
        `• **Pump Status:** RUNNING on **${io.label}**\n` +
        `• **Current Tank Fill:** **${io.level}%**\n` +
        `• **Predicted Overflow In:** **${io.eta_overflow_formatted}** (Expected at **${io.expected_overflow_time}**)\n` +
        `• **Smart Cutoff Recommendation:** Switch off pump when level reaches 95% to save electricity and prevent road/terrace overflow.`;
    } else if (wi?.activePumps?.length > 0) {
      const p = wi.activePumps[0];
      reply = `### 🚰 Water Pump Status & ETA\n\n` +
        `• **Pump Status:** ACTIVE on **${p.label}** (Inflow: +${p.inflow_lpm} L/min, Net: +${p.net_flow_lpm} L/min)\n` +
        `• **Current Level:** **${p.tank_level}%**\n` +
        `• **Time to 100% Full:** **${p.eta_overflow_formatted || 'Refilling nominally'}** (Expected at ${p.expected_overflow_time || 'N/A'})\n` +
        `• **Safety Interlock:** Auto-cutoff will trigger at 95% if in Auto mode.`;
    } else {
      reply = `### ⏹️ Water Pump Status: Idle\n\n` +
        `• All water pumps are currently OFF.\n` +
        `• Tanks are draining at normal diurnal consumption rates.\n` +
        `• To start refilling, click **Turn Pump ON** in the Control Panel.`;
    }
  } else if (q.includes('sudden') || q.includes('2hr') || q.includes('2 hours') || q.includes('drop') || q.includes('rapid drain')) {
    const wi = analytics.waterIntelligence;
    if (wi?.temporalLeakAnomalies?.length > 0) {
      const ta = wi.temporalLeakAnomalies[0];
      reply = `### 🚨 AI Temporal Anomaly (Sudden Tank Depletion)\n\n` +
        `• **What Happened:** Tank **${ta.label}** was at **${ta.level_2h_ago}% 2 hours ago**, but has abruptly crashed to **${ta.current_level}%**!\n` +
        `• **Anomaly Analysis:** A drop of **${ta.delta_drop}% in 120 minutes** is 4x greater than normal building consumption (~15%).\n` +
        `• **Conclusion:** Severe hidden leak, burst underground line, or stuck drain tap.\n` +
        `• **Action:** Send plumbing crew immediately to inspect the riser pipe and isolate upstream valves.`;
    } else {
      reply = `### 🧠 AI Temporal Memory Status: Nominal\n\n` +
        `• Historical comparison over the last 2 hours shows smooth, normal diurnal consumption.\n` +
        `• No sudden tank level crashes or unmetered drain anomalies detected.`;
    }
  } else if (q.includes('how can it be improved') || q.includes('improve') || q.includes('recommend') || q.includes('save money') || q.includes('action')) {
    reply = `### 💡 How Can It Be Improved? (Action Plan for ${profile.name})\n\n`;
    analytics.improvements.forEach((imp, i) => {
      reply += `**${i + 1}. [${imp.horizon}] ${imp.icon || '⚡'} ${imp.title}**\n`;
      reply += `• **The Issue:** ${imp.laymanProblem}\n`;
      reply += `• **Money Impact:** ${imp.financialImpact}\n`;
      reply += `• **Recommended Action:** ${imp.action}\n\n`;
    });
  } else if (q.includes('checklist') || q.includes('work order') || q.includes('crew') || q.includes('maintenance')) {
    reply = `### 📋 Maintenance Crew Action Checklist\n\n` +
      `**Assigned To:** ${profile.persona.groundTeam}\n` +
      `**Supervised By:** ${profile.persona.leadEngineer}\n\n` +
      (analytics.improvements.length > 0
        ? analytics.improvements.map((imp, idx) => `[ ] **Task ${idx + 1}:** ${imp.title}\n    • Location: ${imp.action}\n    • Priority: ${imp.priority}`).join('\n\n')
        : `[ ] **Routine Patrol:** Verify LT Panel voltmeter readings (220V - 240V) and inspect overhead tank float switches.`);
  } else {
    reply = `### 🏢 Facility Summary for ${profile.persona.adminTitle}\n\n` +
      `• **Overall Condition:** **${analytics.health.score}%** (${analytics.health.status})\n` +
      `• **Electricity Draw:** **${econ.totalPowerKw} kW** (${econ.hourlyEnergyCostFormatted}/hr under ${econ.todLabel})\n` +
      `• **Water Stored:** **${analytics.trendInsights.waterTrend.averageTankLevel}%** full average across all tanks\n` +
      `• **Waste Receptacles:** **${analytics.wasteIntelligence?.monitoredReceptaclesCount || 4} smart stations** (Avg ${analytics.wasteIntelligence?.averageBinFillPercent || 45}% fill)\n` +
      `• **Active Issues:** ${analytics.health.activeFaultCount} item(s) need attention\n` +
      `• **Top Recommendation:** ${analytics.improvements[0]?.title || 'System running optimally within Indian standards.'}`;
  }

  return { reply, provider: 'Drishti Local Trend Synthesizer' };
}

/**
 * Diagnostic analysis for a single device with non-technical explanations.
 * @param {string} deviceId
 * @param {Object} [options] - { operator, orgId }
 * @returns {Object}
 */
function diagnoseDevice(deviceId, options = {}) {
  const { PROFILES, getActiveProfile } = require('./org-profiles');
  const profile = (options.orgId && PROFILES[options.orgId]) ? PROFILES[options.orgId] : getActiveProfile();
  const analytics = analyzeFacility(profile);
  const readings = engine.getLatest({ labels: true });
  const reading = readings.find(r => r.deviceId === deviceId);

  if (!reading) return null;

  // Domain permission check
  const operator = options.operator;
  if (operator && operator.role !== 'admin' && !operator.domains.includes('*')) {
    const { getDomainForKind } = require('../access/operators');
    const devDomain = getDomainForKind(reading.kind);
    if (!operator.domains.includes(devDomain)) {
      const err = new Error(`Access Restricted: Operator '${operator.name}' with scope '${operator.domains.join(', ')}' is not authorized to inspect devices in the '${devDomain}' domain.`);
      err.status = 403;
      throw err;
    }
  }

  const isPower = reading.kind === 'power_meter';
  const isWater = reading.kind === 'water_tank';
  const isWaste = reading.kind === 'waste_bin' || reading.kind === 'waste_compactor';
  const faultsActive = reading.meta?.faultTypes || [];

  let diagnosis = '';
  let riskLevel = 'LOW';
  let financialCost = '₹0';
  let laymanAnalogy = '';
  let simpleAction = '';

  if (isPower) {
    const pf = reading.values?.power_factor;
    const v = reading.values?.voltage;
    const kw = reading.values?.power_kw;

    if (faultsActive.includes('spike')) {
      riskLevel = 'HIGH';
      diagnosis = `Dangerous voltage spike (${v} V). Exceeds the Indian safety limit of 244 Volts.`;
      laymanAnalogy = 'Like putting 300V through a 230V appliance — high danger of blowing circuit boards and burning motor windings.';
      financialCost = 'Risk of equipment burnout (> ₹50,000)';
      simpleAction = 'Check the voltage stabilizer and transformer On-Load Tap Changer immediately.';
    } else if (faultsActive.includes('overload') || kw > 70) {
      riskLevel = 'HIGH';
      diagnosis = `Circuit overload: Drawing ${kw} kW. Running dangerously close to maximum capacity.`;
      laymanAnalogy = 'Like running too many air conditioners on a single domestic plug — wires are heating up and breaker may trip.';
      financialCost = `Adds ~${formatINR(kw * analytics.economics.effectiveRatePerKwh)}/hr to your electricity bill.`;
      simpleAction = 'Turn off non-essential machines on this floor to prevent the main fuse from tripping.';
    } else if (pf < (profile.benchmarks?.powerFactorMin || 0.90)) {
      riskLevel = 'MEDIUM';
      diagnosis = `Low electrical efficiency (Power Factor: ${pf} vs 0.90 standard).`;
      laymanAnalogy = 'Motor equipment is drawing extra useless current that overheats wiring and triggers electricity board penalties.';
      financialCost = 'Attracts monthly DISCOM surcharge penalties.';
      simpleAction = 'Tell the electrician to switch on capacitor steps at the main LT panel.';
    } else {
      diagnosis = `Operating cleanly (${kw} kW, ${v} V, ${pf} PF) within Indian CEA/BIS safety limits.`;
      laymanAnalogy = 'Equipment is running smoothly and energy-efficiently.';
      financialCost = 'Normal electricity tariff';
      simpleAction = 'No action required. Everything is operating normally.';
    }
  } else if (isWater) {
    const lpm = reading.values?.flow_lpm || 0;
    const bar = reading.values?.pressure_bar;
    const level = reading.values?.tank_level_percent;

    if (faultsActive.includes('burst')) {
      riskLevel = 'CRITICAL';
      diagnosis = `Catastrophic water pipe rupture (${lpm} litres/minute flow)!`;
      laymanAnalogy = 'A main delivery pipe has cracked open — tank is emptying rapidly and could flood basements or grounds.';
      financialCost = `~${formatINR(lpm * 60 * 0.25)}/hr in replacement tanker water.`;
      simpleAction = 'Shut off the main supply valve to this tank immediately and stop the booster pump.';
    } else if (faultsActive.includes('leak') || lpm > 20) {
      riskLevel = 'HIGH';
      diagnosis = `Active water leak detected (${lpm} litres/minute flow). Tank fill is ${level}%.`;
      laymanAnalogy = 'Continuous water loss equivalent to leaving 10 bathroom taps wide open all day.';
      financialCost = `Wasting ~${(lpm * 60).toLocaleString('en-IN')} Litres/hour (~${formatINR(lpm * 60 * 0.25)}/hr).`;
      simpleAction = 'Inspect the tank ball-float valve and check for pipe cracks along the riser line.';
    } else if (bar < 2.0) {
      riskLevel = 'MEDIUM';
      diagnosis = `Low water pressure (${bar} bar vs standard 2.5 - 3.5 bar).`;
      laymanAnalogy = 'Water pressure is too weak — taps on upper floors may sputter or stop flowing.';
      financialCost = 'Water pump inspection required.';
      simpleAction = 'Check if the booster pump has lost prime or if an intake filter is choked.';
    } else {
      diagnosis = `Hydraulic conditions nominal (Level: ${level}%, Pressure: ${bar} bar, Flow: ${lpm} LPM).`;
      laymanAnalogy = 'Water storage and distribution are completely normal.';
      financialCost = 'Standard municipal water rate';
      simpleAction = 'No action required. Tank levels are healthy.';
    }
  } else if (isWaste) {
    const v = reading.values || {};
    const fill = v.fill_level_percent || 0;
    const weight = v.weight_kg || 0;
    const temp = v.temperature_c || 25;

    if (faultsActive.includes('fire_hazard_heat') || temp > 65) {
      riskLevel = 'CRITICAL';
      diagnosis = `Smoldering waste thermal fire hazard (${temp}°C internal temperature).`;
      laymanAnalogy = 'Decomposing materials or discarded cigarette butts have ignited refuse inside the closed receptacle.';
      financialCost = 'Severe fire hazard & campus safety violation.';
      simpleAction = 'Douse with dry chemical fire extinguisher immediately and move receptacle to open outdoor clearing.';
    } else if (faultsActive.includes('compactor_jam') || v.compactor_status === 'JAMMED') {
      riskLevel = 'HIGH';
      diagnosis = `Hydraulic compactor ram is mechanically jammed on oversized refuse.`;
      laymanAnalogy = 'A heavy object is wedged in the compression bay, preventing the hydraulic ram from completing its stroke.';
      financialCost = 'Risk of ₹45,000 hydraulic drive motor coil burnout.';
      simpleAction = 'Isolate power breaker, jog reverse lever, and manually dislodge the obstruction.';
    } else if (faultsActive.includes('bin_overflow') || fill >= 95) {
      riskLevel = 'MEDIUM';
      diagnosis = `Receptacle is ${fill}% full (${weight} kg). Refuse is actively overflowing onto walkways.`;
      laymanAnalogy = 'Bin is piled high over the brim, attracting pests and causing foul odors.';
      financialCost = 'Campus Swachh de-rating citation.';
      simpleAction = 'Dispatch sanitation team to empty receptacle into campus collection vehicle.';
    } else {
      diagnosis = `Waste receptacle operating optimally (Fill: ${fill}%, Weight: ${weight} kg, Odor: ${v.odor_index_ppm || 15} ppm).`;
      laymanAnalogy = 'Waste collection and compactor hydraulics are completely nominal.';
      financialCost = 'Standard waste logistics';
      simpleAction = 'No action required. Receptacle is within safe holding limits.';
    }
  }

  const { getDomainForKind } = require('../access/operators');

  return {
    deviceId,
    label: reading.label,
    kind: reading.kind,
    domain: getDomainForKind(reading.kind),
    status: reading.status,
    timestamp: reading.timestamp,
    values: reading.values,
    meta: reading.meta,
    riskLevel,
    financialCost,
    diagnosis,
    laymanAnalogy,
    recommendedAction: simpleAction,
  };
}

module.exports = {
  setConfig,
  getConfig,
  getSynthesis,
  chat,
  diagnoseDevice,
};
