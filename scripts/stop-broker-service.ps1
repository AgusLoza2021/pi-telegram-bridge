# T04 stop-broker-service.ps1 - asks the live broker for a graceful
# shutdown through the state-root control channel and waits (bounded)
# for the shutdownAt confirmation in broker-meta.json.
#
# - Reads the CURRENT live meta first: the stop command is bound to the
#   exact instance id of the running broker (fail-closed on mismatch).
# - Writes broker-control.json ATOMICALLY ({instanceId, command:
#   'stop-broker', issuedAt}) - the exact contract parsed by
#   src/runtime-broker.mjs.
# - Waits at most 20 seconds for shutdownAt; a timeout exits 2 and
#   leaves the evidence in place. NEVER calls Stop-Process and never
#   signals an arbitrary PID.
#
# No stop happens in this session: this file is source only.

param(
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
Test-BridgeStateRootLock -Path $stateRoot | Out-Null

$metaPath = Join-Path $stateRoot 'broker-meta.json'
$live = Get-BrokerLiveMeta -StateRoot $stateRoot
if ($null -eq $live) {
    Write-Host 'no live broker (broker-meta.json absent, stale or already shut down).'
    exit 0
}

$instanceId = Get-BridgeMetaField -Meta $live -Name 'instanceId'
if ($null -eq $instanceId -or $instanceId -notmatch '^[0-9a-f]{32}$') {
    throw 'broker-meta.json carries no valid instance id; refusing to write a control file.'
}

Write-BrokerStopControl -StateRoot $stateRoot -InstanceId $instanceId
Write-Host "stop-broker requested for instance $instanceId (pid $($live.pid)); waiting up to 20s..."

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $meta = Read-JsonFile -Path $metaPath
    if ($null -ne $meta -and $null -ne (Get-BridgeMetaField -Meta $meta -Name 'shutdownAt')) {
        Write-Host 'broker stopped gracefully (shutdownAt recorded).'
        exit 0
    }
    if ($null -ne $meta -and $null -ne (Get-BridgeMetaField -Meta $meta -Name 'pid')) {
        $stillAlive = Get-Process -Id ([int](Get-BridgeMetaField -Meta $meta -Name 'pid')) -ErrorAction SilentlyContinue
        if ($null -eq $stillAlive) {
            Write-Host 'broker process exited.'
            exit 0
        }
    }
}

Write-Host 'the broker did not confirm a shutdown within 20s; the control file and meta remain in place as evidence. Check scripts/status-broker-service.ps1.'
exit 2
