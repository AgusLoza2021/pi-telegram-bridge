# T04 broker-service-common.ps1 - shared helpers for the current-user
# Windows scheduled-task lifecycle of the selective-TUI broker
# (src/runtime-broker.mjs). Windows PowerShell 5.1+. Dot-sources the
# bridge-wide helpers; adds the task-specific contract on top.
#
# The scheduled task is DEDICATED (one fixed task name), runs as the
# CURRENT INTERACTIVE USER with LogonType Interactive and RunLevel
# Limited. It is never LocalSystem and never stores a Windows password:
# "Interactive" means it only runs while this user is logged on, so no
# credential material is embedded in the task XML, the argv or any
# environment block.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

# The dedicated task name is a constant by design: uninstall may only
# ever touch this exact task, never a wildcard or a discovered one.
function Get-BrokerServiceTaskName {
    return 'PiTelegramBridgeBroker'
}

<#
.SYNOPSIS
Builds the dedicated task settings. Idle-stop must be disabled explicitly:
Windows' default ten-minute idle window can otherwise terminate the broker
with STATUS_CONTROL_C_EXIT. Unexpected exits get three bounded restart
attempts; IgnoreNew still prevents concurrent Telegram pollers.
#>
function New-BrokerServiceTaskSettings {
    return New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
}

<#
.SYNOPSIS
Fail-closed readback of the registered XML. Construction success is not
enough: Task Scheduler must persist the settings that keep one broker alive.
#>
function Assert-BrokerServiceTaskXml {
    param([Parameter(Mandatory = $true)][string]$TaskXml)
    if ([string]::IsNullOrWhiteSpace($TaskXml)) {
        throw 'registered task XML was empty'
    }
    $required = @(
        '<DisallowStartIfOnBatteries>\s*false\s*</DisallowStartIfOnBatteries>',
        '<StopIfGoingOnBatteries>\s*false\s*</StopIfGoingOnBatteries>',
        '<StopOnIdleEnd>\s*false\s*</StopOnIdleEnd>',
        '<ExecutionTimeLimit>\s*PT0S\s*</ExecutionTimeLimit>',
        '<MultipleInstancesPolicy>\s*IgnoreNew\s*</MultipleInstancesPolicy>',
        '<StartWhenAvailable>\s*true\s*</StartWhenAvailable>',
        '<RestartOnFailure>[\s\S]*?<Interval>\s*PT1M\s*</Interval>',
        '<RestartOnFailure>[\s\S]*?<Count>\s*3\s*</Count>'
    )
    foreach ($pattern in $required) {
        if ($TaskXml -notmatch $pattern) {
            throw "registered task settings verification failed ($pattern)"
        }
    }
    return $true
}

<#
.SYNOPSIS
Resolves the absolute node.exe that the task action will pin. The task
must not depend on the logon-session PATH: a scheduled logon trigger may
run before the user profile finishes composing PATH, so the exact path
resolved today is frozen into the task XML.
#>
function Get-BrokerNodeExePath {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'node was not found on PATH. Install Node.js 24 or newer first.'
    }
    return $node.Source
}

<#
.SYNOPSIS
Hard prerequisites for install/start: Windows PowerShell 5.1+ and
Node.js 24+. Returns $false with a human-readable reason on failure.
#>
function Test-BrokerServicePrerequisites {
    $version = $PSVersionTable.PSVersion
    if ($version.Major -lt 5 -or ($version.Major -eq 5 -and $version.Minor -lt 1)) {
        Write-Host "Windows PowerShell 5.1 or newer is required (found $($version.ToString()))."
        return $false
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        Write-Host 'node was not found on PATH. Install Node.js 24 or newer first.'
        return $false
    }
    $versionOutput = (& $node.Source --version 2>$null | Select-Object -First 1)
    if ("$versionOutput" -notmatch '^v(\d+)\.') {
        Write-Host "could not determine the node version ('node --version' printed '$versionOutput')."
        return $false
    }
    if ([int]$Matches[1] -lt 24) {
        Write-Host "Node.js 24 or newer is required (found $versionOutput)."
        return $false
    }
    return $true
}

<#
.SYNOPSIS
Backup directory for task-XML exports: <module>\.local\backups. Created
on demand; entries are NEVER deleted (audit trail by construction).
#>
function Get-BrokerServiceBackupDir {
    $dir = Join-Path (Get-BridgeModuleRoot) '.local\backups'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

<#
.SYNOPSIS
Dated export of the CURRENT task definition BEFORE it is replaced or
removed. Returns the backup path, or $null when the task does not exist.
#>
function Backup-BrokerServiceTaskXml {
    param([Parameter(Mandatory = $true)][string]$TaskName)
    if ($null -eq (Get-BrokerServiceTask -TaskName $TaskName)) { return $null }
    $xml = Export-ScheduledTask -TaskName $TaskName
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path (Get-BrokerServiceBackupDir) "$TaskName.$stamp.xml"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($backupPath, $xml, $utf8NoBom)
    return $backupPath
}

function Get-BrokerServiceManifestPath {
    return (Join-Path (Get-BridgeModuleRoot) '.local\broker-service-manifest.json')
}

<#
.SYNOPSIS
Writes the NONSECRET install manifest (task name, node/module paths,
state directory, current SID/user, install time). Contains no token, no
Telegram ids and no credential material by construction.
#>
function Write-BrokerServiceManifest {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$ModuleRoot,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][bool]$CredentialsPresent,
        [Parameter(Mandatory = $true)][bool]$TaskEnabled
    )
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $manifest = [PSCustomObject]@{
        version             = 1
        kind                = 'pi-telegram-bridge-broker-service-manifest'
        taskName            = $TaskName
        nodePath            = $NodeExe
        modulePath          = $ModuleRoot
        stateDirectory      = $StateDirectory
        sid                 = $identity.User.Value
        user                = $identity.Name
        credentialsPresent  = $CredentialsPresent
        taskEnabled         = $TaskEnabled
        installedAt         = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-JsonFileAtomic -Path (Get-BrokerServiceManifestPath) -Value $manifest
    return $manifest
}

function Get-BrokerServiceTask {
    param([string]$TaskName = (Get-BrokerServiceTaskName))
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

<#
.SYNOPSIS
True when DPAPI credentials AND the runtime ops config exist in the
state root - the minimum for the broker to actually boot. Blob presence
is checked read-only; the plaintext is never touched here.
#>
function Test-BrokerCredentialsPresent {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
    if (-not (Test-Path -LiteralPath (Get-BridgeBlobPath -StateRoot $StateRoot))) { return $false }
    $config = Read-JsonFile -Path (Get-BridgeConfigPath -StateRoot $StateRoot)
    if ($null -eq $config -or $null -eq (Get-BridgeMetaField -Meta $config -Name 'instanceId')) { return $false }
    return $true
}

<#
.SYNOPSIS
Safe field read for JSON objects parsed from disk: under StrictMode a
missing property would otherwise throw. Used on every broker-meta.json /
runtime.json read so a truncated or foreign file degrades to "not live"
instead of crashing a lifecycle script.
#>
function Get-BridgeMetaField {
    param(
        [Parameter(Mandatory = $true)]$Meta,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $Meta.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

<#
.SYNOPSIS
Reads broker-meta.json and returns it ONLY when it describes a live
broker: pid is a running process, no shutdownAt recorded and (when an
expected instance id is given) the instance id matches exactly. Returns
$null otherwise. NEVER inspects credentials; NEVER signals the process.
#>
function Get-BrokerLiveMeta {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [string]$InstanceId
    )
    $meta = Read-JsonFile -Path (Join-Path $StateRoot 'broker-meta.json')
    if ($null -eq $meta) { return $null }
    $metaPid = Get-BridgeMetaField -Meta $meta -Name 'pid'
    if ($null -eq $metaPid -or [int]$metaPid -le 0) { return $null }
    if ($null -ne (Get-BridgeMetaField -Meta $meta -Name 'shutdownAt')) { return $null }
    if (-not [string]::IsNullOrEmpty($InstanceId)) {
        $metaInstance = Get-BridgeMetaField -Meta $meta -Name 'instanceId'
        if ($metaInstance -ne $InstanceId) { return $null }
    }
    $alive = Get-Process -Id $metaPid -ErrorAction SilentlyContinue
    if ($null -eq $alive) { return $null }
    return $meta
}

<#
.SYNOPSIS
True when the meta heartbeat is recent enough to trust a fresh start
(the broker rewrites it every 10s; 30s covers GC pauses and cold starts).
#>
function Test-BrokerHeartbeatFresh {
    param(
        [Parameter(Mandatory = $true)]$Meta,
        [int]$MaxAgeSeconds = 30
    )
    $heartbeatAt = Get-BridgeMetaField -Meta $Meta -Name 'heartbeatAt'
    if ($null -eq $heartbeatAt) { return $false }
    $ageMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() - [int64]$heartbeatAt
    return ($ageMs -ge 0 -and $ageMs -le $MaxAgeSeconds * 1000)
}

<#
.SYNOPSIS
Bounded wait for a FRESH broker-meta.json heartbeat proving the just
requested start: live process, no shutdownAt, matching instance id and a
heartbeat inside the freshness window. Returns the live meta or $null on
timeout (never throws a process signal at anything).
#>
function Wait-BrokerServiceHeartbeat {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $meta = Get-BrokerLiveMeta -StateRoot $StateRoot -InstanceId $InstanceId
        if ($null -ne $meta -and (Test-BrokerHeartbeatFresh -Meta $meta)) {
            return $meta
        }
    }
    return $null
}

<#
.SYNOPSIS
Enables and starts the dedicated task. Kept as one helper so install
(-Start) and start share the exact same enable-then-start order.
#>
function Start-BrokerServiceTask {
    param([Parameter(Mandatory = $true)][string]$TaskName)
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

<#
.SYNOPSIS
Writes the typed broker control command bound to the EXACT instance id
that is currently live (field names MUST match the Node contract parsed
by src/runtime-broker.mjs: { instanceId, command, issuedAt }). Atomic
write; a stale instance id is refused fail-closed - the stop file must
never command a foreign broker.
#>
function Write-BrokerStopControl {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][string]$InstanceId
    )
    if ($InstanceId -notmatch '^[0-9a-f]{32}$') {
        throw 'instance id must be 32 hex chars'
    }
    $control = [PSCustomObject]@{
        instanceId = $InstanceId
        command    = 'stop-broker'
        issuedAt   = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    }
    Write-JsonFileAtomic -Path (Join-Path $StateRoot 'broker-control.json') -Value $control
    return $true
}
