# T04 status.ps1 - credential-free, identity-free runtime status.
# The heavy lifting (liveness probes, heartbeat age, request states) is
# done by src/bridge-control.mjs; this script renders it for humans and
# optionally emits raw JSON for scripting (-Json switch).

param(
    [switch]$Json,
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
$arguments = @('status', '--state-dir', $stateRoot)
if ($Json) { $arguments += '--json' }

$result = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\bridge-control.mjs') `
    -Arguments $arguments
if ($result.ExitCode -ne 0) {
    Write-Host "status failed: $($result.StdErr.Trim())"
    exit 1
}
Write-Host $result.StdOut.Trim()
if (-not $Json) {
    Write-Host ''
    Write-Host 'stop: scripts/stop.ps1   start: scripts/start.ps1   logs: .local\state\logs'
}
