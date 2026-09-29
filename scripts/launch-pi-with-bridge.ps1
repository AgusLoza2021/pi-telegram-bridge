# T08 launch-pi-with-bridge.ps1 - starts Pi with the bridge loaded for
# THIS window only (pi-telegram.cmd is the double-click entry point).
# Windows PowerShell 5.1+. Starts exactly one process: the owner's own
# 'pi' command.
#
# Why this exists: Pi auto-discovers <profile>\.pi\agent\extensions, so a
# bridge copy under that root would load in every project and every
# session and would inject its tool description into every system prompt
# whether or not the owner wants the bridge there. The installer therefore
# deploys the payload OUTSIDE every discovery root, and Pi loads it only
# when a session is started with an explicit 'pi -e <payload>' - which is
# exactly what this script does.
#
# Contract:
# - Never changes the working directory: 'pi' must open the project the
#   caller is standing in, never this module folder.
# - Never passes -ne/--no-extensions: the owner's own project extensions
#   (and the other global ones) must keep loading alongside the bridge.
# - Forwards every extra argument verbatim - there is deliberately NO
#   param block, so with -File (and with a direct call) unbound arguments
#   land in $args untouched - and propagates Pi's exit code.
# - Starts nothing else: no broker, no service, no Telegram connection.
#   The window still starts DISCONNECTED until the owner turns the phone
#   connection on and links the window with /tg.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'selective-extension-common.ps1')

$payload = Get-SelectiveOnDemandExtensionDir
$entry = Join-Path $payload 'index.ts'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    Write-Host ''
    Write-Host 'pi-telegram: the bridge is not installed for this Windows user yet.'
    Write-Host "Expected payload: $entry"
    Write-Host 'Fix: run scripts\install-selective-extension.ps1 once, then try again.'
    exit 1
}

# Prefer a real Windows entry point: the npm folder ships both an
# extensionless 'pi' shell script and 'pi.cmd', and PowerShell can only
# start the latter. Refusing with a named cause beats letting '&' fail
# with a bare "not recognized as the name of a cmdlet" error.
$piCandidates = @(Get-Command -Name 'pi' -CommandType Application -ErrorAction SilentlyContinue)
$pi = $piCandidates |
    Where-Object { $_.Source -match '\.(cmd|exe|bat)$' } |
    Select-Object -First 1
if ($null -eq $pi) {
    Write-Host ''
    if ($piCandidates.Count -gt 0) {
        Write-Host 'pi-telegram: found "pi" on PATH, but not a runnable Windows entry point.'
        Write-Host "Found: $($piCandidates[0].Source)"
        Write-Host 'Expected pi.cmd or pi.exe: install the Pi coding agent, then reopen this window.'
    } else {
        Write-Host 'pi-telegram: could not find the "pi" command on PATH.'
        Write-Host 'Fix: install the Pi coding agent, then reopen this window.'
    }
    exit 1
}

$piArguments = @()
if ($null -ne $args -and $args.Count -gt 0) {
    foreach ($argument in $args) { $piArguments += [string]$argument }
}

Write-Host "pi-telegram: starting Pi with the bridge loaded from $payload"
Write-Host 'pi-telegram: this window starts DISCONNECTED; use /tg (or "telegram on") when you want the phone.'

& $pi.Source -e $payload @piArguments
exit $LASTEXITCODE
