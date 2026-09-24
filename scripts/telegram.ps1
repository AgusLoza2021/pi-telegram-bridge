# T07 telegram.ps1 - the single on/off switch for the phone connection.
#
# The connection is OFF until the owner asks for it. The ENABLED BIT of
# the dedicated scheduled task IS that intent, which is why this switch
# adds no flag file and no second source of truth:
#
#   on    -> refuses without credentials, then enables and starts the
#            task and waits (bounded) for a fresh broker heartbeat
#   off   -> asks for the instance-bound graceful stop and, ONLY once
#            that stop is confirmed, disables the task so the next
#            sign-in starts nothing
#   status-> read-only verdict plus the existing status report
#
# No task is touched while this file is only source.

param(
    [Parameter(Position = 0)]
    [ValidateSet('on', 'off', 'status')]
    [string]$Action = 'status',

    # Turns a double-click into an interactive menu. It never changes the
    # on/off semantics: every menu action re-invokes this same script as a
    # child process, so the switch below stays the only implementation.
    [switch]$Menu,

    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
$taskName = Get-BrokerServiceTaskName

# The menu always opens with the current state: it routes through the real
# status path below instead of carrying a second status implementation.
if ($Menu) { $Action = 'status' }

if ($Action -eq 'status') {
    $switchTask = Get-BrokerServiceTask -TaskName $taskName
    $switchEnabled = $false
    if ($null -ne $switchTask) { $switchEnabled = [bool]$switchTask.Settings.Enabled }
    $switchLive = Get-BrokerLiveMeta -StateRoot $stateRoot

    if ($switchEnabled -and $null -ne $switchLive) {
        Write-Host 'CONNECTION: ON - the task is enabled and the broker is live.'
    } elseif ($switchEnabled) {
        Write-Host 'CONNECTION: ON - the task is enabled, but no broker is live right now.'
        Write-Host 'Run "telegram on" to start it before sending a Telegram message.'
    } else {
        Write-Host 'CONNECTION: OFF - the task is disabled; nothing starts at sign-in.'
        Write-Host 'Run "telegram on" when you leave home.'
    }
    Write-Host ''
    # status-broker-service.ps1 never calls exit, so running it here is a
    # plain report and cannot terminate this host.
    & (Join-Path $PSScriptRoot 'status-broker-service.ps1') -StateDirectory $stateRoot
}

if ($Action -eq 'on') {
    if (-not (Test-BrokerServicePrerequisites)) { exit 1 }
    Test-BridgeStateRootLock -Path $stateRoot | Out-Null

    # Without credentials the task cannot work, and enabling it would only
    # create a start-crash-restart loop on the next sign-in.
    if (-not (Test-BrokerCredentialsPresent -StateRoot $stateRoot)) {
        Write-Host 'SETUP_REQUIRED - credentials are missing. Run scripts/setup.ps1 first; the connection was not enabled.'
        exit 2
    }

    $config = Test-BridgeConfig -StateRoot $stateRoot
    if ($null -eq $config) { exit 1 }
    $instanceId = Get-BridgeMetaField -Meta $config -Name 'instanceId'
    if ($null -eq $instanceId -or $instanceId -notmatch '^[0-9a-f]{32}$') {
        throw 'runtime.json carries no valid instance id; re-run scripts/setup.ps1.'
    }

    $task = Get-BrokerServiceTask -TaskName $taskName
    if ($null -eq $task) {
        Write-Host "the task $taskName is not installed. Run scripts/install-broker-service.ps1 first."
        exit 1
    }

    # Reuse a live broker: starting a second one would fight for the same
    # Telegram long poll.
    $live = Get-BrokerLiveMeta -StateRoot $stateRoot -InstanceId $instanceId
    if ($null -ne $live -and (Test-BrokerHeartbeatFresh -Meta $live)) {
        Write-Host "CONNECTION: ON - a broker is already running (pid $($live.pid)); reusing it."
        exit 0
    }

    Start-BrokerServiceTask -TaskName $taskName
    Write-Host 'connection enabled; waiting for the broker heartbeat...'

    $meta = Wait-BrokerServiceHeartbeat -StateRoot $stateRoot -InstanceId $instanceId -TimeoutSeconds 30
    if ($null -eq $meta) {
        Write-Host 'the broker did not report a fresh heartbeat within 30s; the task stays enabled so the next retry can recover. Check the logs under .local\state\logs.'
        exit 2
    }
    Write-Host "CONNECTION: ON (pid $($meta.pid)). Send the Telegram message again."
    exit 0
}

if ($Action -eq 'off') {
    Test-BridgeStateRootLock -Path $stateRoot | Out-Null
    $stopped = Stop-BrokerServiceTask -StateRoot $stateRoot -TaskName $taskName -TimeoutSeconds 20
    if (-not $stopped) {
        Write-Host 'the broker did not confirm a graceful stop within 20s; the task was left ENABLED and the control file stays on disk as evidence. Check scripts/status-broker-service.ps1.'
        exit 2
    }
    Write-Host 'CONNECTION: OFF - the broker stopped and the task is disabled; nothing will start at sign-in.'
    exit 0
}

if ($Menu) {
    if ([Console]::IsInputRedirected) {
        # A redirected caller cannot answer a prompt: the status report above
        # is the whole interaction, so leave instead of spinning on input
        # that will never arrive.
        exit 0
    }
    while ($true) {
        Write-Host ''
        Write-Host 'What do you want to do?'
        Write-Host '  1 - turn the connection ON'
        Write-Host '  2 - turn the connection OFF'
        Write-Host '  3 - show the connection status'
        Write-Host '  4 - quit'
        $choice = Read-Host 'Choose 1-4'
        if ($choice -eq '1' -or $choice -eq '2' -or $choice -eq '3') {
            $childAction = @{ '1' = 'on'; '2' = 'off'; '3' = 'status' }[$choice]
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath $childAction
            Write-Host "(that action finished with exit code $LASTEXITCODE)"
        } elseif ($choice -eq '4') {
            exit 0
        }
        # An empty or invalid answer simply falls back to the prompt above.
    }
}
