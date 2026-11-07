# test/test-faults.ps1
# ─────────────────────────────────────────────────────────────
# PowerShell test script for Windows — injects every fault type,
# verifies readings change, verifies recovery after clearing.
#
# Usage:
#   cd "d:\simulated-sensor backend"
#   .\test\test-faults.ps1
#
# Environment variables (optional):
#   $env:BASE_URL = "http://localhost:3000"
#   $env:API_KEY  = "your-api-key"
# ─────────────────────────────────────────────────────────────

$BASE_URL = if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3000" }
$API_KEY  = if ($env:API_KEY)  { $env:API_KEY  } else { "" }
$Pass = 0; $Fail = 0

# ── Helpers ──────────────────────────────────────────────────

function Write-Ok   { param($msg) Write-Host "  [PASS] $msg" -ForegroundColor Green; $script:Pass++ }
function Write-Fail { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red;   $script:Fail++ }
function Write-Hdr  { param($msg) Write-Host "`n$msg" -ForegroundColor Cyan }

function Invoke-Api {
  param([string]$Method, [string]$Path, [string]$Body = $null)
  $uri     = "$BASE_URL$Path"
  $headers = @{ "Content-Type" = "application/json" }
  if ($API_KEY) { $headers["x-api-key"] = $API_KEY }

  try {
    if ($Body) {
      return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $Body -ErrorAction Stop
    } else {
      return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -ErrorAction Stop
    }
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Host "    HTTP $status : $($_.Exception.Message)" -ForegroundColor DarkYellow
    return $null
  }
}

function Check-Anomaly {
  param([string]$DeviceId)
  $r = Invoke-Api -Method GET -Path "/api/devices/$DeviceId/latest?labels=true"
  if ($r -and $r.meta) { return $r.meta.isAnomaly }
  return $null
}

function Inject-Fault {
  param([string]$Body)
  $r = Invoke-Api -Method POST -Path "/api/faults" -Body $Body
  if ($r) { return $r.id }
  return $null
}

function Clear-FaultById {
  param([string]$Id)
  Invoke-Api -Method DELETE -Path "/api/faults/$Id" | Out-Null
}

function SleepTicks { Start-Sleep -Seconds 3 }

# Resolve first device of each kind
$allDevices = Invoke-Api -Method GET -Path "/api/devices"
$PWR_ID = ($allDevices | Where-Object { $_.kind -eq "power_meter" } | Select-Object -First 1).deviceId
$WAT_ID = ($allDevices | Where-Object { $_.kind -eq "water_tank"  } | Select-Object -First 1).deviceId

# ─────────────────────────────────────────────────────────────

Write-Hdr "0. Connectivity"
$health = Invoke-Api -Method GET -Path "/api/health"
if ($health -and $health.status -eq "ok") { Write-Ok  "Health endpoint OK" }
else                                      { Write-Fail "Health endpoint failed" }

# ─────────────────────────────────────────────────────────────

Write-Hdr "1. Power meter faults"

@("spike", "sag", "overload", "power_factor_drop", "frequency_drift") | ForEach-Object {
  $ft = $_
  $fid = Inject-Fault -Body "{`"deviceId`":`"$PWR_ID`",`"type`":`"$ft`",`"severity`":0.9}"
  SleepTicks
  $anom = Check-Anomaly -DeviceId $PWR_ID
  if ($anom -eq $true)  { Write-Ok   "$ft — anomaly detected" }
  else                  { Write-Fail "$ft — anomaly NOT detected (got: $anom)" }
  Clear-FaultById -Id $fid
  SleepTicks
  $anom2 = Check-Anomaly -DeviceId $PWR_ID
  if ($anom2 -eq $false) { Write-Ok   "$ft — recovered to normal" }
  else                   { Write-Fail "$ft — did not recover (anomaly: $anom2)" }
}

# Blackout with auto-clear
$fid = Inject-Fault -Body "{`"deviceId`":`"$PWR_ID`",`"type`":`"blackout`",`"severity`":1.0,`"durationSec`":5}"
Start-Sleep -Seconds 6
$latest = Invoke-Api -Method GET -Path "/api/devices/$PWR_ID/latest"
$v = if ($latest -and $latest.values) { $latest.values.power_kw } else { -1 }
if ($v -eq 0) { Write-Ok "blackout — power_kw is 0" }
else          { Write-Fail "blackout — expected power_kw=0, got $v" }
Start-Sleep -Seconds 3

# ─────────────────────────────────────────────────────────────

Write-Hdr "2. Water tank faults"

@("leak", "burst", "low_pressure") | ForEach-Object {
  $ft  = $_
  $fid = Inject-Fault -Body "{`"deviceId`":`"$WAT_ID`",`"type`":`"$ft`",`"severity`":0.9}"
  SleepTicks
  $anom = Check-Anomaly -DeviceId $WAT_ID
  if ($anom -eq $true) { Write-Ok   "$ft — anomaly detected" }
  else                 { Write-Fail "$ft — anomaly NOT detected" }
  Clear-FaultById -Id $fid
  SleepTicks
}

@("tank_overflow", "tank_dry") | ForEach-Object {
  $ft  = $_
  $fid = Inject-Fault -Body "{`"deviceId`":`"$WAT_ID`",`"type`":`"$ft`",`"severity`":1.0,`"durationSec`":5}"
  Start-Sleep -Seconds 6
  $anom = Check-Anomaly -DeviceId $WAT_ID
  if ($anom -eq $true) { Write-Ok   "$ft — anomaly detected" }
  else                 { Write-Fail "$ft — anomaly NOT detected" }
  Start-Sleep -Seconds 3
}

# ─────────────────────────────────────────────────────────────

Write-Hdr "3. Common faults"

@("sensor_offline", "stuck_value", "noisy", "drift") | ForEach-Object {
  $ft  = $_
  $fid = Inject-Fault -Body "{`"deviceId`":`"$PWR_ID`",`"type`":`"$ft`",`"severity`":0.8}"
  SleepTicks
  $anom = Check-Anomaly -DeviceId $PWR_ID
  if ($anom -eq $true) { Write-Ok   "$ft — anomaly detected" }
  else                 { Write-Fail "$ft — anomaly NOT detected" }
  Clear-FaultById -Id $fid
  SleepTicks
}

# ─────────────────────────────────────────────────────────────

Write-Hdr "4. Attack / cyber-physical faults"

@("spoofed_sensor","replay_attack","out_of_range","value_injection","duplicate_flood","clock_skew","missing_heartbeat") | ForEach-Object {
  $ft  = $_
  $fid = Inject-Fault -Body "{`"deviceId`":`"$PWR_ID`",`"type`":`"$ft`",`"severity`":0.9}"
  SleepTicks
  $anom = Check-Anomaly -DeviceId $PWR_ID
  if ($anom -eq $true) { Write-Ok   "$ft — attack labeled" }
  else                 { Write-Fail "$ft — NOT labeled (got: $anom)" }
  Clear-FaultById -Id $fid
  SleepTicks
}

# ─────────────────────────────────────────────────────────────

Write-Hdr "5. Target resolution"

$fid = Inject-Fault -Body '{"labelPrefix":"Building A","type":"spike","severity":0.7}'
SleepTicks
if ($fid) { Write-Ok "labelPrefix target OK (faultId: $fid)" }
else      { Write-Fail "labelPrefix target failed" }
Clear-FaultById -Id $fid

$fid = Inject-Fault -Body '{"kind":"water_tank","type":"noisy","severity":0.5}'
SleepTicks
if ($fid) { Write-Ok "kind target OK" }
else      { Write-Fail "kind target failed" }
Clear-FaultById -Id $fid

$fid = Inject-Fault -Body '{"target":"all","type":"drift","severity":0.3,"durationSec":3}'
SleepTicks
if ($fid) { Write-Ok "all target OK" }
else      { Write-Fail "all target failed" }
Start-Sleep -Seconds 4

# ─────────────────────────────────────────────────────────────

Write-Hdr "6. Push endpoint — HMAC validation"

$newDev = Invoke-Api -Method POST -Path "/api/devices" -Body '{"kind":"power_meter","label":"Push Test PS"}'
$newId  = if ($newDev) { $newDev.deviceId } else { $null }
$code   = if ($newDev) { $newDev.claimCode } else { $null }
$claimed = Invoke-Api -Method POST -Path "/api/claim" -Body "{`"claimCode`":`"$code`"}"
$secret = if ($claimed) { $claimed.secret } else { $null }

if ($secret) {
  Write-Ok "Claim flow - secret obtained"
  # Push with wrong signature (should get 401)
  try {
    $ts  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $badResp = Invoke-WebRequest -Uri "$BASE_URL/api/push/$newId" -Method POST `
      -Headers @{ "Content-Type"="application/json"; "x-device-id"=$newId; "x-timestamp"=$ts; "x-seq"="1"; "x-signature"="badhex" } `
      -Body '{"values":{"power_kw":42}}' -ErrorAction SilentlyContinue
    if ($badResp.StatusCode -eq 401) {
      Write-Ok "Bad signature -> 401 Unauthorized"
    } else {
      Write-Fail "Bad signature not rejected (got $($badResp.StatusCode))"
    }
  } catch {
    # Invoke-WebRequest throws on non-2xx; that's what we expect
    Write-Ok "Bad signature -> rejected with error"
  }

  # Second claim attempt (should fail with 410)
  $reClaim = Invoke-Api -Method POST -Path "/api/claim" -Body "{`"claimCode`":`"$code`"}"
  if ($reClaim -eq $null) {
    Write-Ok "Duplicate claim -> rejected"
  } else {
    Write-Fail "Duplicate claim was accepted (expected rejection)"
  }
} else {
  Write-Fail "Claim flow - could not obtain secret"
}

# ─────────────────────────────────────────────────────────────

Write-Hdr "7. Scenarios"

@("night-leak","overload","blackout","pipe-burst","multi-fault","rogue-sensor","replay-attack","data-tampering") | ForEach-Object {
  $sname = $_
  $r = Invoke-Api -Method POST -Path "/api/scenarios/$sname"
  if ($r -and $null -ne $r.injected -and $r.injected -ge 0) {
    Write-Ok "Scenario '$sname' - $($r.injected) fault(s)"
  } else {
    Write-Fail "Scenario '$sname' - failed"
  }
  Start-Sleep -Seconds 1
  Invoke-Api -Method DELETE -Path "/api/faults" | Out-Null
  Start-Sleep -Seconds 2
}

# ─────────────────────────────────────────────────────────────

Write-Hdr "8. Fault log"

$log = Invoke-Api -Method GET -Path "/api/faults/log"
if ($log.Count -gt 0) {
  Write-Ok "Fault log - $($log.Count) entries"
} else {
  Write-Fail "Fault log empty"
}

# ─────────────────────────────────────────────────────────────

Write-Host "`nResults: " -NoNewline
Write-Host "$Pass passed" -ForegroundColor Green -NoNewline
Write-Host ", " -NoNewline
Write-Host "$Fail failed" -ForegroundColor Red
if ($Fail -gt 0) { exit 1 } else { exit 0 }
