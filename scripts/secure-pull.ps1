<#
.SYNOPSIS
    Secure Pull & Merge Workflow with Automated Functionality Verification
.DESCRIPTION
    Safely fetches and merges code from GitHub only if:
    1. Working directory is safely stashed/preserved
    2. No unresolvable merge conflicts occur
    3. Syntax check passes on all JavaScript files
    4. Full 99-test functionality suite passes completely
    If any check fails, changes are automatically rolled back to prevent breaking the application!
.EXAMPLE
    npm run pull
    powershell -ExecutionPolicy Bypass -File scripts/secure-pull.ps1
#>

param(
    [string]$Remote = "origin",
    [string]$Branch = ""
)

$ErrorActionPreference = "Stop"

function Write-Step($title) {
    Write-Host "`n`e[1;36m==> $title`e[0m"
}

function Write-Success($msg) {
    Write-Host "`e[1;32m[OK] $msg`e[0m"
}

function Write-Fail($msg) {
    Write-Host "`e[1;31m[FAILED] $msg`e[0m"
}

Write-Host "`n`e[1;35m=====================================================`e[0m"
Write-Host "`e[1;35m       SENSOR-SIM-API SECURE PULL & MERGE            `e[0m"
Write-Host "`e[1;35m=====================================================`e[0m"

# 1. Detect Current Branch
if (-not $Branch) {
    $Branch = (git rev-parse --abbrev-ref HEAD).Trim()
}
Write-Step "Checking current state (Branch: $Branch, Remote: $Remote)"

# 2. Check Working Tree Cleanliness
$stashed = $false
$status = (git status --porcelain)
if ($status) {
    Write-Host "Uncommitted local changes detected. Stashing safely..."
    $stashStamp = "secure-pull-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    git stash push -m $stashStamp | Out-Null
    $stashed = $true
    Write-Success "Local changes stashed under '$stashStamp'"
} else {
    Write-Success "Working directory is clean"
}

$PREV_HEAD = (git rev-parse HEAD).Trim()

try {
    # 3. Secure Fetch
    Write-Step "Fetching latest commits securely from $Remote/$Branch..."
    git fetch $Remote $Branch
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch from remote '$Remote/$Branch'."
    }

    $incomingCount = (git rev-list --count HEAD.."$Remote/$Branch").Trim()
    if ([int]$incomingCount -eq 0) {
        $aheadCount = (git rev-list --count "$Remote/$Branch"..HEAD).Trim()
        if ([int]$aheadCount -gt 0) {
            Write-Success "Local branch '$Branch' is ahead of $Remote/$Branch by $aheadCount commit(s) and already includes all remote commits."
        } else {
            Write-Success "Local branch '$Branch' is completely up to date with $Remote/$Branch."
        }

        # Run test verification to ensure current code works perfectly
        Write-Step "Verifying all functionality tests on current code..."
        node test/run-tests.js
        if ($LASTEXITCODE -ne 0) {
            throw "Functionality tests failed!"
        }
        Write-Success "All functionality tests passed with 100% success!"

        if ($stashed) {
            Write-Host "Restoring your uncommitted changes..."
            git stash pop | Out-Null
            Write-Success "Stash restored"
        }

        Write-Host "`n`e[1;32m=====================================================`e[0m"
        Write-Host "`e[1;32m SUCCESS: Code verified & perfectly synchronized!    `e[0m"
        Write-Host "`e[1;32m=====================================================`e[0m`n"
        exit 0
    }

    Write-Host "New remote commit(s) detected ($incomingCount incoming). Remote HEAD: $REMOTE_HEAD"

    # 4. Safe Trial Merge (Pre-commit)
    Write-Step "Simulating trial merge without committing..."
    $mergeOutput = git merge --no-commit --no-ff "$Remote/$Branch" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Merge conflict encountered! Aborting merge to protect local codebase."
        git merge --abort 2>$null
        throw "Merge conflict detected. Please resolve conflicts manually before merging."
    }
    Write-Success "Merge simulation cleanly integrated without conflicts"

    # 5. Dependency Check
    $diffFiles = git diff --cached --name-only $PREV_HEAD
    if ($diffFiles -match "package.*json") {
        Write-Step "Package configuration changed in remote. Installing dependencies..."
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed on incoming dependencies."
        }
        Write-Success "Dependencies up to date"
    }

    # 6. Syntax Integrity Check
    Write-Step "Running JavaScript syntax & static compilation check..."
    npm run test:syntax
    if ($LASTEXITCODE -ne 0) {
        throw "Syntax verification failed on incoming changes!"
    }
    Write-Success "All source files passed syntax verification"

    # 7. Comprehensive Functionality Test Suite
    Write-Step "Running comprehensive functionality test suite (99 checks)..."
    node test/run-tests.js
    if ($LASTEXITCODE -ne 0) {
        throw "Functionality tests FAILED on incoming remote code!"
    }
    Write-Success "All 99 functionality tests passed with 100% success!"

    # 8. Finalize Merge Commit
    Write-Step "Finalizing secure merge..."
    git commit -m "Merge remote-tracking branch '$Remote/$Branch' (Verified with 99-test suite)" | Out-Null
    Write-Success "Merge finalized successfully!"

    # 9. Restore Stash if needed
    if ($stashed) {
        Write-Host "Restoring stashed local changes..."
        git stash pop | Out-Null
        Write-Success "Stash restored successfully"
    }

    Write-Host "`n`e[1;32m=====================================================`e[0m"
    Write-Host "`e[1;32m SUCCESS: Code pulled & merged securely!             `e[0m"
    Write-Host "`e[1;32m Every backend functionality was verified.           `e[0m"
    Write-Host "`e[1;32m=====================================================`e[0m`n"
    exit 0

} catch {
    Write-Host "`n`e[1;31m=====================================================`e[0m"
    Write-Host "`e[1;31m ROLLBACK TRIGGERED: Pull aborted to protect codebase `e[0m"
    Write-Host "`e[1;31m Error: $_`e[0m"
    Write-Host "`e[1;31m=====================================================`e[0m`n"

    # Roll back cleanly to initial commit
    try { git merge --abort 2>&1 | Out-Null } catch {}
    try { git reset --hard $PREV_HEAD 2>&1 | Out-Null } catch {}

    if ($stashed) {
        Write-Host "Restoring your original local changes..."
        try { git stash pop 2>&1 | Out-Null } catch {}
    }

    Write-Host "`e[1;33mYour repository was restored to its safe pre-pull state ($PREV_HEAD).`e[0m`n"
    exit 1
}
