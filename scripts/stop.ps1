# T04r stop.ps1 - asks the running host for a graceful shutdown through
# the local control channel and waits (bounded) for it to finish.
#
# It NEVER kills an arbitrary pid: the stop command is bound to the
# configured instance id (fail-closed on identity mismatch), the wait is
# bounded, and a timeout exits 2 WITHOUT forcing anything.
#
# Modes:
#   (default)    stop the whole host (host + worker + Pi).
#   -WorkerOnly  stop only the worker (control stop-worker); the host and
#                its Pi child keep running (generation unchanged).

param(
    [switch]$WorkerOnly,
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
Test-BridgeStateRootLock -Path $stateRoot | Out-Null

$config = Test-BridgeConfig -StateRoot $stateRoot
if ($null -eq $config) { exit 1 }

$command = if ($WorkerOnly) { 'stop-worker' } else { 'stop-host' }

$result = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\bridge-control.mjs') `
    -Arguments @('control', '--command', $command, '--state-dir', $stateRoot, '--instance', $config.instanceId)
if ($result.ExitCode -ne 0) {
    Write-Host "could not write the stop command: $($result.StdErr.Trim())"
    exit 1
}

$deadline = (Get-Date).AddSeconds(20)
$metaPath = Join-Path $stateRoot 'host-meta.json'
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $meta = Read-JsonFile -Path $metaPath
    if ($WorkerOnly) {
        if ($null -ne $meta -and $null -eq $meta.workerPid) {
            Write-Host 'bridge worker stopped (host untouched, generation unchanged).'
            exit 0
        }
    } else {
        if ($null -ne $meta -and $null -ne $meta.shutdownAt) {
            Write-Host 'bridge host stopped.'
            exit 0
        }
        if ($null -ne $meta -and $null -ne $meta.pid) {
            $alive = Get-Process -Id $meta.pid -ErrorAction SilentlyContinue
            if ($null -eq $alive) {
                Write-Host 'bridge host process exited.'
                exit 0
            }
        }
    }
}
if ($WorkerOnly) {
    Write-Host 'the worker did not stop within 20s; check scripts/status.ps1.'
} else {
    Write-Host 'the host did not confirm a shutdown within 20s; check scripts/status.ps1.'
}
exit 2
