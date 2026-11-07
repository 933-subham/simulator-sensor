<#
.SYNOPSIS
    Configures git to use the repository's automated verification hooks (.githooks)
#>
$ErrorActionPreference = "Stop"

git config core.hooksPath .githooks
Write-Host "Git hooks configured successfully! (core.hooksPath set to .githooks)"
Write-Host "Any future 'git pull' or 'git merge' will automatically verify all backend tests."
