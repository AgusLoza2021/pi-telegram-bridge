# T04 uninstall-broker-service.ps1 - reverses the install cleanly.
#
# - If a broker is live, requests a graceful stop first (same control
#   channel as stop-broker-service.ps1, bounded wait).
# - Exports the task XML to a dated backup BEFORE unregistering.
# - Unregisters ONLY the exact dedicated task name - never a wildcard,
#   never a discovered task.
# - Leaves state, credentials, logs and backups intact. Idempotent when
#   the task is absent.
#
# No uninstall happens in this session: this file is source only.

param(
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory

# The state root is only enforced when it exists: uninstall of a task
# whose state was never created must still be able to run (idempotent).
# When the root EXISTS it must carry the verified user-only ACL - fail
# closed, never weaken, before touching anything.
if (Test-Path -LiteralPath $stateRoot -PathType Container) {
    Test-BridgeStateRootLock -Path $stateRoot | Out-Null
}

$taskName = Get-BrokerServiceTaskName
$task = Get-BrokerServiceTask -TaskName $taskName

if ($null -eq $task) {
    Write-Host "task $taskName is not installed; nothing to do (state, credentials, logs and backups untouched)."
    exit 0
}

# Graceful stop first: never unregister under a live broker.
$live = Get-BrokerLiveMeta -StateRoot $stateRoot
if ($null -ne $live) {
    $instanceId = Get-BridgeMetaField -Meta $live -Name 'instanceId'
    if ($null -eq $instanceId -or $instanceId -notmatch '^[0-9a-f]{32}$') {
        throw 'broker-meta.json carries no valid instance id; refusing to stop or uninstall.'
    }
    Write-BrokerStopControl -StateRoot $stateRoot -InstanceId $instanceId
    Write-Host "graceful stop requested for instance $instanceId; waiting up to 20s..."
    $stopped = Wait-BrokerServiceShutdown -StateRoot $stateRoot -TimeoutSeconds 20
    if (-not $stopped) {
        Write-Host 'the broker did not confirm a shutdown within 20s; uninstall aborted (evidence left in place). Run scripts/stop-broker-service.ps1 and retry.'
        exit 2
    }
    Write-Host 'broker stopped.'
}

# Dated XML backup BEFORE unregistering; never deleted afterwards.
$backupPath = Backup-BrokerServiceTaskXml -TaskName $taskName
if ($null -ne $backupPath) {
    Write-Host "task XML exported to backup: $backupPath"
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "task $taskName unregistered."
Write-Host 'State, credentials, logs and backups were left intact.'
