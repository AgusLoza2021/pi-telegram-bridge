# T05 status-selective-extension.ps1 - read-only, credential-free status
# of the globally installed selective-TUI Pi extension. Windows
# PowerShell 5.1+.
#
# Reports ONLY: whether the extension is installed, whether the install
# manifest is present, whether the recorded source hashes are current
# or stale, the destination path and the install time. Nothing is
# created, modified or deleted; no credential material is read.
#
# -Json emits the same information as a JSON object.

param(
    [switch]$Json
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'selective-extension-common.ps1')

$manifest = Read-SelectiveManifest
$destination = Join-Path (Get-SelectiveExtensionsRoot) (Get-SelectiveGlobalExtensionName)
# Read-only reparse check: never report an extension as installed when
# the chain below the profile was swapped for a junction.
Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $destination

# Installed means: the dedicated directory exists with a live entry
# file. A dot-prefixed leftover or a defused entry does not count.
$installed = $false
if (Test-Path -LiteralPath $destination -PathType Container) {
    if (Test-Path -LiteralPath (Join-Path $destination 'index.ts') -PathType Leaf) {
        $installed = $true
    }
}

$installedAt = $null
$sourceStates = @()
if ($null -ne $manifest) {
    $installedAt = Get-SelectiveManifestField -Manifest $manifest -Name 'installedAt'
    $files = Get-SelectiveManifestField -Manifest $manifest -Name 'files'
    if ($null -ne $files) {
        foreach ($record in @($files)) {
            $relativePath = Get-SelectiveManifestField -Manifest $record -Name 'relativePath'
            $recordedHash = Get-SelectiveManifestField -Manifest $record -Name 'sha256'
            $sourcePath = Get-SelectiveManifestField -Manifest $record -Name 'sourcePath'
            $state = 'source-missing'
            $currentHash = $null
            if (-not [string]::IsNullOrEmpty($sourcePath) -and (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                $currentHash = Get-SelectiveSha256 -Path $sourcePath
                if ($currentHash -eq $recordedHash) { $state = 'current' } else { $state = 'stale' }
            }
            $sourceStates += [PSCustomObject]@{
                relativePath   = $relativePath
                recordedSha256 = $recordedHash
                currentSha256  = $currentHash
                status         = $state
            }
        }
    }
}

$report = [PSCustomObject]@{
    extensionName   = (Get-SelectiveGlobalExtensionName)
    installed       = $installed
    manifestPresent = ($null -ne $manifest)
    destination     = $destination
    installedAt     = $installedAt
    sources         = $sourceStates
}

if ($Json) {
    # Depth 4 covers the sources array; Compress keeps the output
    # machine-readable without a BOM (Write-JsonFileAtomic conventions).
    ($report | ConvertTo-Json -Depth 4)
    return
}

Write-Host "Extension:            $($report.extensionName)"
Write-Host "Installed:            $(if ($report.installed) { 'Yes' } else { 'No' })"
Write-Host "Install manifest:     $(if ($report.manifestPresent) { 'Present' } else { 'Absent' })"
Write-Host "Destination:          $($report.destination)"
Write-Host "Installed at:         $(if ($report.installedAt) { $report.installedAt } else { 'n/a' })"
if ($sourceStates.Count -gt 0) {
    Write-Host 'Source files:'
    foreach ($item in $sourceStates) {
        Write-Host ("  {0,-40} {1}" -f $item.relativePath, $item.status)
    }
} else {
    Write-Host 'Source files:         n/a (no manifest)'
}
