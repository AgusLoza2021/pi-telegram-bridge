# T04r start.ps1 - starts the bridge host detached (its own hidden
# process, no scheduled task, no autostart, no service registration).
# The host owns the real pi pipes and supervises the Telegram worker child.
#
# Modes:
#   (default)   full production host + worker.
#   -HostOnly   credential-free real-Pi host: the fixed local /bridge-demo
#               lifecycle starts and the demo dialog stays PENDING (never
#               auto-answered). Useful for live diagnostics without the
#               worker; stop with scripts/stop.ps1.
#   -WorkerOnly no new host: requires a live host and (re)starts only the
#               worker via its control file - a worker restart never bumps
#               the host generation and never restarts Pi.
#
# A start against an ALIVE host reuses it: it only ensures the worker
# (control start-worker); no generation bump, no double spawn.

param(
    [switch]$HostOnly,
    [switch]$WorkerOnly,
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
Test-BridgeStateRootLock -Path $stateRoot | Out-Null

$moduleRoot = Get-BridgeModuleRoot
$metaPath = Join-Path $stateRoot 'host-meta.json'
$configPath = Get-BridgeConfigPath -StateRoot $stateRoot

function Test-HostAlive {
    param([string]$Path)
    $meta = Read-JsonFile -Path $Path
    if ($null -eq $meta -or $null -eq $meta.pid -or $null -ne $meta.shutdownAt) { return $null }
    $alive = Get-Process -Id $meta.pid -ErrorAction SilentlyContinue
    if ($null -eq $alive) { return $null }
    return $meta
}

if ($WorkerOnly) {
    # Worker-only start: a live host is REQUIRED; we never spawn a second
    # host. The host picks the typed control command up on its next tick.
    $meta = Test-HostAlive -Path $metaPath
    if ($null -eq $meta) {
        Write-Host 'ERR:no_live_host (worker-only needs a running host; start it without -WorkerOnly first)'
        exit 1
    }
    Write-BridgeControl -StateRoot $stateRoot -Command 'start-worker' -InstanceId $meta.instanceId
    Write-Host "start-worker requested for host $($meta.instanceId) (pid $($meta.pid)); generation untouched."
    exit 0
}

if ($HostOnly) {
    # Credential-free real-Pi diagnostics host.
    # The exact state root MUST be forwarded: with a custom -StateDirectory
    # the prerequisites are validated against THAT root, never the default
    # one. The helper returns a real boolean, so -not is the correct
    # predicate (a $null -eq comparison would pass on a $false return).
    if (-not (Test-BridgePrerequisites -StateRoot $stateRoot)) { exit 1 }
} else {
    if (-not (Test-BridgePrerequisites -RequireCredentials -StateRoot $stateRoot)) { exit 1 }
}

if ($null -eq (Test-BridgeConfig -StateRoot $stateRoot)) { exit 1 }

# A live host is REUSED, never duplicated: just ensure the worker.
$meta = Test-HostAlive -Path $metaPath
if ($null -ne $meta) {
    Write-Host "host already running (pid $($meta.pid), instance $($meta.instanceId)); reusing it (no generation bump)."
    if (-not $HostOnly) {
        Write-BridgeControl -StateRoot $stateRoot -Command 'start-worker' -InstanceId $meta.instanceId
        Write-Host 'start-worker requested.'
    }
    exit 0
}

$logDir = Join-Path $stateRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
# Rotate before reuse: previous run's output is archived, never truncated
# and never deleted.
Rotate-BridgeLogFile -Path (Join-Path $logDir 'host-stdout.log')
Rotate-BridgeLogFile -Path (Join-Path $logDir 'host-stderr.log')

$stdoutLog = Join-Path $logDir 'host-stdout.log'
$stderrLog = Join-Path $logDir 'host-stderr.log'
$hostScript = Join-Path $moduleRoot 'src\runtime-host.mjs'

$modeArgs = @()
if ($HostOnly) { $modeArgs = @('--host-only') }

$process = Start-Process -FilePath 'node' `
    -ArgumentList @("`"$hostScript`"", '--state-dir', "`"$stateRoot`"", '--config', "`"$configPath`"" + $modeArgs) `
    -WorkingDirectory $moduleRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$modeLabel = if ($HostOnly) { 'host-only (real Pi, demo pending, no worker)' } else { 'production' }
Write-Host "bridge host starting - $modeLabel (pid $($process.Id))."
Write-Host 'Verify with scripts/status.ps1. Smoke first? scripts/smoke-windows.ps1'
