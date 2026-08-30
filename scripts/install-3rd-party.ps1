[CmdletBinding()]
param(
    [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
    [string]$Profile = 'win-debug',

    [string]$Version = 'pinned',

    [string]$DshHome,

    [string]$ApprovedBy,

    [switch]$ApproveUnpinned,

    [switch]$Apply,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Apply -and $DryRun) {
    throw 'Choose either -Apply or -DryRun, not both.'
}

$driver = Join-Path $PSScriptRoot 'install-3rd-party.mjs'
$driverArgs = @(
    $driver,
    '--platform', 'windows',
    '--profile', $Profile,
    '--version', $Version
)

if ($DshHome) {
    $driverArgs += @('--dsh-home', $DshHome)
}
if ($ApprovedBy) {
    $driverArgs += @('--approved-by', $ApprovedBy)
}
if ($ApproveUnpinned) {
    $driverArgs += '--approve-unpinned'
}

if ($Apply) {
    if (-not $DshHome) {
        throw '-DshHome is required with -Apply.'
    }
    if (-not $ApprovedBy) {
        throw '-ApprovedBy is required with -Apply.'
    }
    $driverArgs += '--apply'
} else {
    $driverArgs += '--dry-run'
}

& node @driverArgs
if ($LASTEXITCODE -ne 0) {
    throw "Third-party installer failed with exit code $LASTEXITCODE."
}
