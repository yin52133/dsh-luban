[CmdletBinding()]
param(
    [ValidatePattern('^[a-z0-9][a-z0-9-]*$')]
    [string]$Profile = 'win-debug',

    [string]$Version = 'pinned',

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

if ($Apply) {
    $driverArgs += '--apply'
} else {
    $driverArgs += '--dry-run'
}

& node @driverArgs
if ($LASTEXITCODE -ne 0) {
    throw "Third-party installer failed with exit code $LASTEXITCODE."
}
