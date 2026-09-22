# T04 start-broker-service.ps1 - enables and starts the dedicated
# scheduled task, then waits (bounded) for a fresh broker-meta.json
# heartbeat proving the broker is actually alive.
#
# - Requires DPAPI credentials: without them the task cannot work and a
#   start attempt would only create a logon failure loop.
# - Reuses a live broker: if broker-meta.json already describes a live
#   process with a fresh heartbeat and the exact runtime instance id, no
#   second start is issued (no duplicates).
# - The wait is bounded; a timeout exits 2 WITHOUT signalling any
#   process. No Stop-Process anywhere in this script.
#
# No start happens in this session: this file is source only.

param(
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

if (-not (Test-BrokerServicePrerequisites)) { exit 1 }

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
Test-BridgeStateRootLock -Path $stateRoot | Out-Null

if (-not (Test-BrokerCredentialsPresent -StateRoot $stateRoot)) {
    Write-Host 'SETUP_REQUIRED - credentials are missing. Run scripts/setup.ps1 first; the task was not started.'
    exit 2
}

$config = Test-BridgeConfig -StateRoot $stateRoot
if ($null -eq $config) { exit 1 }
$instanceId = Get-BridgeMetaField -Meta $config -Name 'instanceId'
if ($null -eq $instanceId -or $instanceId -notmatch '^[0-9a-f]{32}$') {
    throw 'runtime.json carries no valid instance id; re-run scripts/setup.ps1.'
}

$taskName = Get-BrokerServiceTaskName
$task = Get-BrokerServiceTask -TaskName $taskName
if ($null -eq $task) {
    Write-Host "the task $taskName is not installed. Run scripts/install-broker-service.ps1 first."
    exit 1
}

# Reuse a live broker instead of starting a duplicate.
$live = Get-BrokerLiveMeta -StateRoot $stateRoot -InstanceId $instanceId
if ($null -ne $live -and (Test-BrokerHeartbeatFresh -Meta $live)) {
    Write-Host "broker already running (pid $($live.pid), instance $instanceId); reusing it."
    exit 0
}

Start-BrokerServiceTask -TaskName $taskName
Write-Host "task $taskName enabled and started; waiting for the broker heartbeat..."

$meta = Wait-BrokerServiceHeartbeat -StateRoot $stateRoot -InstanceId $instanceId -TimeoutSeconds 30
if ($null -eq $meta) {
    Write-Host "the broker did not report a fresh heartbeat within 30s; check the logs under .local\state\logs and scripts/status-broker-service.ps1."
    exit 2
}
Write-Host "broker is live (pid $($meta.pid), instance $instanceId)."
