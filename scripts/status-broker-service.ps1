# T04 status-broker-service.ps1 - credential-free status of the dedicated
# scheduled task and the broker it manages.
#
# - Reports installed/enabled/task state and ONLY bounded broker health
#   fields (pid, instance id, heartbeat age, shutdown state). NEVER a
#   token, a Telegram id or a session file path.
# - Credential-free: the DPAPI blob is never read or unlocked here.
# - -Json emits a machine-readable object for scripting.
#
# No task mutation happens in this session: this file is source only.

param(
    [switch]$Json,
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
$taskName = Get-BrokerServiceTaskName

$task = Get-BrokerServiceTask -TaskName $taskName
$installed = $null -ne $task
$enabled = $false
$taskState = 'NotInstalled'
if ($installed) {
    $taskState = $task.State.ToString()
    $enabled = [bool]$task.Settings.Enabled
}

$meta = Read-JsonFile -Path (Join-Path $stateRoot 'broker-meta.json')
$live = Get-BrokerLiveMeta -StateRoot $stateRoot
$brokerLive = $null -ne $live
$brokerPid = $null
$instanceId = $null
$heartbeatAgeSeconds = $null
$shutdownRecorded = $false
if ($null -ne $meta) {
    $brokerPid = Get-BridgeMetaField -Meta $meta -Name 'pid'
    $instanceId = Get-BridgeMetaField -Meta $meta -Name 'instanceId'
    $shutdownRecorded = $null -ne (Get-BridgeMetaField -Meta $meta -Name 'shutdownAt')
    $heartbeatAt = Get-BridgeMetaField -Meta $meta -Name 'heartbeatAt'
    if ($null -ne $heartbeatAt) {
        $heartbeatAgeSeconds = [int]([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - [int64]$heartbeatAt) / 1000
    }
}

$credentialsPresent = Test-BrokerCredentialsPresent -StateRoot $stateRoot

$status = [PSCustomObject]@{
    taskName            = $taskName
    installed           = $installed
    enabled             = $enabled
    taskState           = $taskState
    credentialsPresent  = $credentialsPresent
    brokerLive          = $brokerLive
    brokerPid           = $brokerPid
    instanceId          = $instanceId
    heartbeatAgeSeconds = $heartbeatAgeSeconds
    shutdownRecorded    = $shutdownRecorded
}

if ($Json) {
    $status | ConvertTo-Json -Depth 4
} else {
    Write-Host "task:      $taskName"
    Write-Host "installed: $installed"
    Write-Host "enabled:   $enabled"
    Write-Host "state:     $taskState"
    Write-Host "credentials present: $credentialsPresent"
    Write-Host "broker live: $brokerLive"
    if ($brokerLive) {
        Write-Host "broker pid: $($live.pid)"
        Write-Host "instance:  $instanceId"
        Write-Host "heartbeat age: $heartbeatAgeSeconds s"
    } elseif ($shutdownRecorded) {
        Write-Host 'broker: stopped gracefully (shutdownAt recorded).'
    }
    if ($installed -and -not $credentialsPresent) {
        Write-Host 'SETUP_REQUIRED - credentials are missing; the task is disabled.'
    }
    Write-Host ''
    Write-Host 'start: scripts/start-broker-service.ps1   stop: scripts/stop-broker-service.ps1'
}
