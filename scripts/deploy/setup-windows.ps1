[CmdletBinding()]
param(
  [string]$DshHome,
  [switch]$Apply,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if ($Apply -and $DryRun) {
  throw '-Apply and -DryRun are mutually exclusive.'
}

$setupScript = Join-Path $PSScriptRoot 'setup-profile.mjs'
$setupArgs = @($setupScript, '--profile', 'win-debug')
if ($DshHome) {
  $setupArgs += @('--dsh-home', $DshHome)
}
$setupArgs += if ($Apply) { '--apply' } else { '--dry-run' }

& node @setupArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
