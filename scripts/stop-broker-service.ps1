# T04 stop-broker-service.ps1 - asks the live broker for a graceful
# shutdown through the state-root control channel and waits (bounded)
# for the shutdownAt confirmation in broker-meta.json.
#
# - Reads the CURRENT live meta first: the stop command is bound to the
#   exact instance id of the running broker (fail-closed on mismatch).
# - Writes broker-control.json ATOMICALLY ({instanceId, command:
#   'stop-broker', issuedAt}) - the exact contract parsed by
#   src/runtime-broker.mjs.
# - Waits at most 20 seconds for shutdownAt; a timeout exits 2, leaves
#   the task ENABLED and the evidence in place. NEVER calls Stop-Process
#   and never signals an arbitrary PID.
# - Once the graceful stop IS confirmed it also DISABLES the task: that is
#   what keeps the phone connection off across the next sign-in. The
#   on-demand switch (scripts/telegram.ps1 off) shares this same helper.
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

$live = Get-BrokerLiveMeta -StateRoot $stateRoot
if ($null -eq $live) {
    Write-Host 'no live broker (broker-meta.json absent, stale or already shut down).'
}

$taskName = Get-BrokerServiceTaskName
$stopped = Stop-BrokerServiceTask -StateRoot $stateRoot -TaskName $taskName -TimeoutSeconds 20
if (-not $stopped) {
    Write-Host 'the broker did not confirm a shutdown within 20s; the task was left ENABLED and the control file and meta remain in place as evidence. Check scripts/status-broker-service.ps1.'
    exit 2
}

Write-Host 'broker stopped gracefully and the task is disabled; nothing will start at the next logon.'
exit 0
