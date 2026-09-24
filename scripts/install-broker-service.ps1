# T04 install-broker-service.ps1 - registers the DEDICATED current-user
# scheduled task that starts the selective-TUI broker at logon.
#
# - Task: PiTelegramBridgeBroker, trigger AtLogOn of the CURRENT user,
#   principal = current interactive user, LogonType Interactive,
#   RunLevel Limited. Never LocalSystem; no Windows password is ever
#   stored or prompted for.
# - Action: <absolute node.exe> <absolute src/runtime-broker.mjs>
#   --state-dir <absolute confined state dir>, working directory = module
#   root, hidden. No token, no Telegram ids, no credential material in
#   the task XML, argv or environment.
# - Idempotent: an existing task is exported to a dated XML backup under
#   .local\backups and re-registered in place; backups are never deleted.
# - Prerequisites: Windows PowerShell 5.1+, Node 24+, confined state
#   root with a verified current-user ACL (through the existing common
#   helpers; ACLs are never weakened).
# - On-demand default: the task is ALWAYS registered DISABLED, whatever
#   the credential state. Nothing may start at logon until the owner turns
#   the connection on with the telegram switch; -Start is the explicit
#   opt-in for a caller that has just enrolled credentials.
#
# No registration happens in this session: this file is source only.

param(
    [switch]$Start,
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'broker-service-common.ps1')

if (-not (Test-BrokerServicePrerequisites)) { exit 1 }

$moduleRoot = Get-BridgeModuleRoot
$brokerScript = Join-Path $moduleRoot 'src\runtime-broker.mjs'
if (-not (Test-Path -LiteralPath $brokerScript)) {
    throw "broker runtime entry not found: $brokerScript"
}
$nodeExe = Get-BrokerNodeExePath

# Confined state directory + verified user-only ACL (read/verify only;
# the ACL is never weakened - Lock/verify helpers live in common.ps1).
$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
Test-BridgeStateRootLock -Path $stateRoot | Out-Null

$taskName = Get-BrokerServiceTaskName
$credentialsPresent = Test-BrokerCredentialsPresent -StateRoot $stateRoot

# Dated XML backup BEFORE any replacement; never deleted afterwards.
$backupPath = Backup-BrokerServiceTaskXml -TaskName $taskName
if ($null -ne $backupPath) {
    Write-Host "Existing task exported to backup: $backupPath"
}

$identityName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-BrokerServiceTaskTrigger -UserIdentity $identityName
$principal = New-ScheduledTaskPrincipal -UserId $identityName `
    -LogonType Interactive -RunLevel Limited
$settings = New-BrokerServiceTaskSettings
$action = New-ScheduledTaskAction -Execute $nodeExe `
    -Argument ('"{0}" --state-dir "{1}"' -f $brokerScript, $stateRoot) `
    -WorkingDirectory $moduleRoot

Register-ScheduledTask -TaskName $taskName -Trigger $trigger -Principal $principal `
    -Settings $settings -Action $action -Force | Out-Null

# On-demand default: disable the freshly registered task immediately after
# registering it, so a sign-in starts nothing even if the readback below
# fails. Register-then-disable is the only route on PowerShell 5.1, and the
# readback then observes a disabled task, which is the intended state.
# Only an explicit owner action enables it again - the telegram switch, or
# this installer's -Start - which is also why a missing credential can no
# longer produce a logon failure loop: nothing runs at logon unless the
# owner asked for it.
Disable-ScheduledTask -TaskName $taskName | Out-Null

# Read back what Task Scheduler actually persisted. A successful cmdlet
# call must never hide an idle-stop/restart policy regression.
$registeredTaskXml = Export-ScheduledTask -TaskName $taskName
Assert-BrokerServiceTaskXml -TaskXml $registeredTaskXml | Out-Null

$taskEnabled = $false

$manifest = Write-BrokerServiceManifest -TaskName $taskName -NodeExe $nodeExe -ModuleRoot $moduleRoot `
    -StateDirectory $stateRoot -CredentialsPresent $credentialsPresent -TaskEnabled $taskEnabled

Write-Host ''
if ($credentialsPresent) {
    Write-Host 'INSTALL OK - task registered DISABLED; nothing starts at logon.'
    if (-not $Start) {
        Write-Host 'Turn the connection on with "telegram on" (or re-run install with -Start).'
    }
} else {
    Write-Host 'SETUP_REQUIRED - credentials are missing; the task was registered DISABLED.'
    Write-Host 'Run scripts/setup.ps1 to enroll, then turn the connection on with "telegram on".'
}
Write-Host "Task: $taskName (logon trigger, current user, Interactive, Limited)."
Write-Host "Node: $nodeExe"
Write-Host "Broker: $brokerScript"
Write-Host "State: $stateRoot"
Write-Host "Manifest: $(Get-BrokerServiceManifestPath)"

if ($Start) {
    if (-not $credentialsPresent) {
        Write-Host 'Cannot start: credentials are missing (SETUP_REQUIRED).'
        exit 2
    }
    Start-BrokerServiceTask -TaskName $taskName
    Write-Host 'Task started; verify with scripts/status-broker-service.ps1.'
}
