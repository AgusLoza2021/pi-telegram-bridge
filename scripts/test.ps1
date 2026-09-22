# T04 test.ps1 - the single validation entry for this module:
#   1. the full node:test suite (including the PowerShell 5.1 parser
#      checks in tests/ps-scripts.test.mjs);
#   2. an explicit parse pass over every scripts/*.ps1 with the Windows
#      PowerShell 5.1 parser (the exact engine scripts run under).
# Exits non-zero on the first failure class.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$moduleRoot = Get-BridgeModuleRoot
$failed = $false

Write-Host '== node:test suite =='
$tests = Join-Path $moduleRoot 'tests'
$nodeResult = Invoke-BridgeNode -Script (Join-Path $moduleRoot 'scripts\run-tests.mjs')
if ($nodeResult.ExitCode -ne 0) {
    Write-Host $nodeResult.StdOut
    Write-Host $nodeResult.StdErr
    Write-Host 'TESTS FAILED'
    $failed = $true
} else {
    Write-Host $nodeResult.StdOut.Trim()
    Write-Host 'TESTS OK'
}

Write-Host ''
Write-Host '== PowerShell 5.1 parse checks =='
$parserErrors = $null
foreach ($script in Get-ChildItem -LiteralPath (Join-Path $moduleRoot 'scripts') -Filter '*.ps1') {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        Write-Host "PARSE FAIL: $($script.Name)"
        foreach ($e in $parseErrors) { Write-Host "  $($e.Message)" }
        $failed = $true
    } else {
        Write-Host "PARSE OK: $($script.Name)"
    }
}

if ($failed) { exit 1 }
Write-Host ''
Write-Host 'ALL CHECKS PASSED'
