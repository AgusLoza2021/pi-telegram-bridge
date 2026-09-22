# T04r smoke-windows.ps1 - end-to-end Windows runtime smoke WITHOUT any
# Telegram credential, any real pi process and any network call.
#
# This is the EXPLICITLY NAMED host_demo TEST mode (--demo): the local
# fake adapter simulates the extension flow and the host auto-answers
# the demo dialog. It is NOT the production lifecycle - use
# scripts/smoke-runtime.mjs (verifier) or scripts/start.ps1 -HostOnly
# for the real-Pi host-only path.
#
# What it proves, on the exact engine the scripts run under:
#   - the ops config loads and the host process boots detached-free;
#   - SessionHost + RuntimeHost acquire the lease, write host-meta.json;
#   - the demo dialog is auto-answered and completed through the
#     nonce-bound notify path (host_demo only; production waits pending);
#   - the demo request reaches state 'completed' and the process exits 0.
#
# Nothing is deleted: all smoke artifacts stay under .local\smoke.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$moduleRoot = Get-BridgeModuleRoot
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node was not found on PATH.'
}

# 1. fresh smoke state root + ops config (values are placeholders; the
#    demo adapter never launches pi).
$smokeRoot = Join-Path $moduleRoot '.local\smoke'
if (-not (Test-Path -LiteralPath $smokeRoot)) {
    New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
}
$stateDir = Join-Path $smokeRoot ("run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$instanceId = New-BridgeInstanceId
$config = [PSCustomObject]@{
    version    = 1
    instanceId = $instanceId
    pi         = [PSCustomObject]@{
        cliPath   = (Join-Path $PSHOME 'powershell.exe') # never executed in demo mode
        workspace = $moduleRoot
    }
    bridge     = [PSCustomObject]@{ followupsEnabled = $false }
}
$configPath = Join-Path $stateDir 'runtime.json'
Write-JsonFileAtomic -Path $configPath -Value $config

# 2. run the host in demo mode (foreground; the demo completes itself).
$hostScript = Join-Path $moduleRoot 'src\runtime-host.mjs'
Write-Host "smoke: starting host in demo mode ($stateDir)"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = ("`"$hostScript`" --state-dir `"$stateDir`" --config `"$configPath`" --demo")
$psi.WorkingDirectory = $moduleRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($psi)
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()

$deadline = (Get-Date).AddSeconds(90)
$exited = $false
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { $exited = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $exited) {
    $process.Kill()
    Write-Host 'SMOKE FAIL: host did not finish the demo within 90s'
    exit 2
}
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()

# 3. verdict from the durable record, not from stdout trust.
$meta = Read-JsonFile -Path (Join-Path $stateDir 'host-meta.json')
if ($process.ExitCode -eq 0 -and $null -ne $meta -and $meta.lastDemoResult -eq 'completed') {
    Write-Host 'SMOKE PASS: demo lifecycle completed and recorded in host-meta.json.'
    Write-Host "artifacts kept in: $stateDir"
    exit 0
}
$demoResult = 'missing-meta'
if ($null -ne $meta) { $demoResult = $meta.lastDemoResult }
Write-Host "SMOKE FAIL: exit=$($process.ExitCode) lastDemoResult=$demoResult"
if ($stderr.Trim().Length -gt 0) { Write-Host $stderr.Trim() }
exit 1
