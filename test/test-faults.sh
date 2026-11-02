#!/usr/bin/env bash
# test/test-faults.sh
# ─────────────────────────────────────────────────────────────
# Bash test script — injects every fault type, verifies readings
# change, verifies recovery after clearing.
#
# Usage:
#   chmod +x test/test-faults.sh
#   ./test/test-faults.sh
#
# Environment variables:
#   BASE_URL  — defaults to http://localhost:3000
#   API_KEY   — set if your server requires one
# ─────────────────────────────────────────────────────────────

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-}"
PASS=0; FAIL=0

# ── Helpers ──────────────────────────────────────────────────

green="\033[32m"; red="\033[31m"; reset="\033[0m"; bold="\033[1m"

header() { printf "\n${bold}%s${reset}\n" "$1"; }

ok()   { printf "${green}  ✓ %s${reset}\n" "$1"; ((PASS++)); }
fail() { printf "${red}  ✗ %s${reset}\n" "$1"; ((FAIL++)); }

api() {
  local method="$1"; local path="$2"; shift 2
  local args=(-s -X "$method" -H "Content-Type: application/json")
  [[ -n "$API_KEY" ]] && args+=(-H "x-api-key: $API_KEY")
  curl "${args[@]}" "$@" "${BASE_URL}${path}"
}

# Pick first device of each kind
PWR_ID=$(api GET /api/devices | python3 -c "import sys,json; d=[x for x in json.load(sys.stdin) if x['kind']=='power_meter']; print(d[0]['deviceId'] if d else '')")
WAT_ID=$(api GET /api/devices | python3 -c "import sys,json; d=[x for x in json.load(sys.stdin) if x['kind']=='water_tank'];  print(d[0]['deviceId'] if d else '')")

check_anomaly() {
  local id="$1"
  local isAnomaly
  isAnomaly=$(api GET "/api/devices/${id}/latest?labels=true" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('meta',{}).get('isAnomaly',''))" 2>/dev/null)
  echo "$isAnomaly"
}

inject_fault() {
  local body="$1"
  api POST /api/faults -d "$body" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('id',''))"
}

clear_fault() {
  local id="$1"
  api DELETE "/api/faults/${id}" > /dev/null
}

sleep_short() { sleep 3; }  # wait for a few ticks

# ─────────────────────────────────────────────────────────────

header "0. Connectivity"
resp=$(api GET /api/health)
if echo "$resp" | grep -q '"status":"ok"'; then ok "Health endpoint OK"
else fail "Health endpoint failed: $resp"; fi

# ─────────────────────────────────────────────────────────────

header "1. Power meter faults"

for FAULT_TYPE in spike sag overload power_factor_drop frequency_drift; do
  fid=$(inject_fault "{\"deviceId\":\"$PWR_ID\",\"type\":\"$FAULT_TYPE\",\"severity\":0.9}")
  sleep_short
  anom=$(check_anomaly "$PWR_ID")
  if [[ "$anom" == "True" ]]; then ok "$FAULT_TYPE — anomaly detected"
  else fail "$FAULT_TYPE — anomaly NOT detected (got: $anom)"; fi
  clear_fault "$fid"
  sleep_short
  anom2=$(check_anomaly "$PWR_ID")
  if [[ "$anom2" == "False" ]]; then ok "$FAULT_TYPE — recovered to normal"
  else fail "$FAULT_TYPE — did not recover (anomaly: $anom2)"; fi
done

# Blackout (durationSec=5)
fid=$(inject_fault "{\"deviceId\":\"$PWR_ID\",\"type\":\"blackout\",\"severity\":1.0,\"durationSec\":5}")
sleep 6
vals=$(api GET "/api/devices/$PWR_ID/latest" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('values',{}).get('power_kw',''))" 2>/dev/null)
if [[ "$vals" == "0.0" || "$vals" == "0" ]]; then ok "blackout — power_kw is 0 during fault"
else fail "blackout — power_kw expected 0, got $vals"; fi
sleep 3  # auto-clears after 5s

# ─────────────────────────────────────────────────────────────

header "2. Water tank faults"

for FAULT_TYPE in leak burst low_pressure; do
  fid=$(inject_fault "{\"deviceId\":\"$WAT_ID\",\"type\":\"$FAULT_TYPE\",\"severity\":0.9}")
  sleep_short
  anom=$(check_anomaly "$WAT_ID")
  if [[ "$anom" == "True" ]]; then ok "$FAULT_TYPE — anomaly detected"
  else fail "$FAULT_TYPE — anomaly NOT detected"; fi
  clear_fault "$fid"
  sleep_short
done

for FAULT_TYPE in tank_overflow tank_dry; do
  fid=$(inject_fault "{\"deviceId\":\"$WAT_ID\",\"type\":\"$FAULT_TYPE\",\"severity\":1.0,\"durationSec\":5}")
  sleep 6
  anom=$(check_anomaly "$WAT_ID")
  if [[ "$anom" == "True" ]]; then ok "$FAULT_TYPE — anomaly detected"
  else fail "$FAULT_TYPE — anomaly NOT detected"; fi
  sleep 3
done

# ─────────────────────────────────────────────────────────────

header "3. Common faults"

for FAULT_TYPE in sensor_offline stuck_value noisy drift; do
  fid=$(inject_fault "{\"deviceId\":\"$PWR_ID\",\"type\":\"$FAULT_TYPE\",\"severity\":0.8}")
  sleep_short
  anom=$(check_anomaly "$PWR_ID")
  if [[ "$anom" == "True" ]]; then ok "$FAULT_TYPE — anomaly detected"
  else fail "$FAULT_TYPE — anomaly NOT detected"; fi
  clear_fault "$fid"
  sleep_short
done

# ─────────────────────────────────────────────────────────────

header "4. Attack / cyber-physical faults"

for FAULT_TYPE in spoofed_sensor replay_attack out_of_range value_injection duplicate_flood clock_skew missing_heartbeat; do
  fid=$(inject_fault "{\"deviceId\":\"$PWR_ID\",\"type\":\"$FAULT_TYPE\",\"severity\":0.9}")
  sleep_short
  anom=$(check_anomaly "$PWR_ID")
  if [[ "$anom" == "True" ]]; then ok "$FAULT_TYPE — anomaly/attack labeled"
  else fail "$FAULT_TYPE — NOT labeled (got: $anom)"; fi
  clear_fault "$fid"
  sleep_short
done

# ─────────────────────────────────────────────────────────────

header "5. Target resolution"

# Label prefix
fid=$(inject_fault "{\"labelPrefix\":\"Building A\",\"type\":\"spike\",\"severity\":0.7}")
sleep_short
[[ -n "$fid" ]] && ok "labelPrefix target — fault injected (id: $fid)" || fail "labelPrefix target — failed"
clear_fault "$fid"

# kind
fid=$(inject_fault "{\"kind\":\"water_tank\",\"type\":\"noisy\",\"severity\":0.5}")
sleep_short
[[ -n "$fid" ]] && ok "kind target — all water_tank devices targeted" || fail "kind target — failed"
clear_fault "$fid"

# all
fid=$(inject_fault "{\"target\":\"all\",\"type\":\"drift\",\"severity\":0.3,\"durationSec\":3}")
sleep_short
[[ -n "$fid" ]] && ok "all target — all devices targeted" || fail "all target — failed"
sleep 4

# ─────────────────────────────────────────────────────────────

header "6. Push endpoint — HMAC validation"

DEV_DATA=$(api POST /api/devices -d '{"kind":"power_meter","label":"Push Test Device"}')
NEW_ID=$(echo "$DEV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('deviceId',''))")
CLAIM_CODE=$(echo "$DEV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('claimCode',''))")
SECRET=$(api POST /api/claim -d "{\"claimCode\":\"$CLAIM_CODE\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('secret',''))")

if [[ -n "$SECRET" ]]; then
  ok "Claim flow — secret obtained"
  # Push with wrong signature
  resp=$(curl -s -X POST "${BASE_URL}/api/push/${NEW_ID}" \
    -H "Content-Type: application/json" \
    -H "x-device-id: ${NEW_ID}" \
    -H "x-timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -H "x-seq: 1" \
    -H "x-signature: badsig" \
    -d '{"values":{"power_kw":42}}')
  if echo "$resp" | grep -q '"error"'; then ok "Push with wrong signature → rejected"
  else fail "Push with wrong signature — was accepted (expected rejection)"; fi
else
  fail "Claim flow — could not obtain secret"
fi

# ─────────────────────────────────────────────────────────────

header "7. Scenarios"

for S in night-leak overload blackout pipe-burst multi-fault rogue-sensor replay-attack data-tampering; do
  resp=$(api POST "/api/scenarios/$S")
  if echo "$resp" | grep -q '"injected"'; then ok "Scenario '$S' — OK"
  else fail "Scenario '$S' — failed: $resp"; fi
  sleep 1
  api DELETE /api/faults > /dev/null   # clear between scenarios
  sleep 2
done

# ─────────────────────────────────────────────────────────────

header "8. Fault log"

log=$(api GET /api/faults/log)
count=$(echo "$log" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [[ "$count" -gt 0 ]]; then ok "Fault log — $count entries recorded"
else fail "Fault log — empty or error"; fi

# ─────────────────────────────────────────────────────────────

printf "\n${bold}Results: ${green}${PASS} passed${reset}, ${red}${FAIL} failed${reset}\n\n"
exit $FAIL
