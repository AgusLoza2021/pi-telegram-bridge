# T05 uninstall-selective-extension.ps1 - idempotent, reversible removal
# of the globally installed selective-TUI Pi extension. Windows
# PowerShell 5.1+. SOURCE ONLY: this session must not execute it.
#
# Semantics (per the T05 contract):
# - The currently installed dedicated directory
#   <profile>\.pi\agent\extensions\pi-telegram-bridge is archived to a
#   timestamped backup under <module>\.local\backups\global-extension\
#   (complete verified copy; NEVER deleted) and moved out of the
#   auto-discovery root.
# - Rollback/reversal: if the install manifest records a prior backup
#   (previousBackupPath) and it still exists, that prior version is
#   restored into the destination from a verified staging copy. The
#   backup itself is preserved. The manifest reference is then cleared,
#   so repeated uninstall runs converge: first run rolls back to the
#   prior version, the next run archives it, and a final run leaves the
#   destination absent - full removal without ever deleting a backup.
# - If the restore fails, the destination is kept ABSENT and all
#   preserved paths are reported.
# - Only the exact dedicated directory is ever touched; other global
#   extensions and Pi's settings.json are never read or written.
# - This script starts no process: the broker, the scheduled task and
#   any running Pi are left alone.

param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'selective-extension-common.ps1')

$manifest = Read-SelectiveManifest
$destination = Join-Path (Get-SelectiveExtensionsRoot) (Get-SelectiveGlobalExtensionName)
# Reparse-checked chain below the profile before anything is moved: a
# planted junction must never be archived through or replaced by.
Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $destination
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path -LiteralPath $destination)) {
    Write-Host 'UNINSTALL OK - the dedicated global extension directory is already absent.'
    if ($null -ne $manifest) {
        $previous = Get-SelectiveManifestField -Manifest $manifest -Name 'previousBackupPath'
        if (-not [string]::IsNullOrEmpty($previous)) {
            Write-Host "Manifest still records a prior backup (kept for reference): $previous"
        }
    }
    Write-Host 'Already-running Pi instances need /reload only if they loaded the extension this session.'
    return
}

if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
    throw "destination exists but is not a directory: $destination"
}

# --- Archive the current installation (copy, verify, then move aside) ---

# Defuse auto-discovery FIRST: a renamed entry means no Pi instance can
# load the extension from this point on, even before the move completes.
Protect-SelectiveEntryFile -Directory $destination -Suffix 'removed'

$backupRoot = Get-SelectiveBackupRoot -Create
$archivePath = Join-Path $backupRoot "uninstalled-$stamp"
New-Item -ItemType Directory -Path $archivePath -Force | Out-Null
Copy-SelectiveDirectoryContents -Source $destination -Target $archivePath

$extensionsRoot = Get-SelectiveExtensionsRoot
$asideDir = Join-Path $extensionsRoot ".pi-telegram-bridge.removing-$stamp"
Move-Item -LiteralPath $destination -Destination $asideDir
Write-Host "Current installation archived to: $archivePath"

# File the moved-aside original under the archive (cross-volume move).
# Non-recursive husk removal only; any failure preserves the leftover
# (inert, non-discoverable) and is reported, never destroyed.
try {
    $asideTarget = Join-Path $archivePath 'removed-original'
    New-Item -ItemType Directory -Path $asideTarget -Force | Out-Null
    Get-ChildItem -LiteralPath $asideDir -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $asideTarget -Force
    }
    Remove-Item -LiteralPath $asideDir -Force | Out-Null
} catch {
    Write-Warning ("could not fully file the removed installation under the archive; leftovers are preserved (inert, non-discoverable) at: $asideDir")
}

# --- Restore the prior backup recorded in the manifest (if present) -----

$previousBackupPath = $null
if ($null -ne $manifest) {
    $previousBackupPath = Get-SelectiveManifestField -Manifest $manifest -Name 'previousBackupPath'
}

$restoredFrom = $null
if (-not [string]::IsNullOrEmpty($previousBackupPath) -and (Test-Path -LiteralPath $previousBackupPath -PathType Container)) {
    $staging = Join-Path $extensionsRoot ".pi-telegram-bridge.restore-$stamp"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $staging
    $restoreOk = $false
    try {
        # Copy the prior backup into staging with a DEFERRED entry name,
        # exactly like install staging: the sibling is never discoverable
        # as a live extension before the atomic rename into place. The
        # 'replaced-original' entry (filed there by the install swap) is
        # backup bookkeeping, never part of the restorable layout.
        Get-ChildItem -LiteralPath $previousBackupPath -Force |
            Where-Object { $_.Name -ne 'index.ts' -and $_.Name -ne 'replaced-original' } | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
            }
        $priorEntry = Join-Path $previousBackupPath 'index.ts'
        if (Test-Path -LiteralPath $priorEntry -PathType Leaf) {
            Copy-Item -LiteralPath $priorEntry -Destination (Join-Path $staging 'index.ts.pending') -Force
        }
        if (-not (Test-Path -LiteralPath (Join-Path $staging 'index.ts.pending') -PathType Leaf)) {
            throw "prior backup has no index.ts entry to restore: $previousBackupPath"
        }
        if (Test-Path -LiteralPath $destination) {
            throw "destination reappeared unexpectedly during restore: $destination"
        }
        Rename-Item -LiteralPath (Join-Path $staging 'index.ts.pending') -NewName 'index.ts'
        Move-Item -LiteralPath $staging -Destination $destination
        $restoreOk = $true
    } catch {
        # Keep the destination ABSENT on restore failure and report every
        # preserved path; the staging leftover is non-discoverable.
        Write-Warning "restore of the prior backup failed: $($_.Exception.Message)"
        Write-Warning "restoring staging leftover preserved at: $staging"
        Write-Warning "prior backup preserved at: $previousBackupPath"
        Write-Warning "current installation archive preserved at: $archivePath"
    }
    if (-not $restoreOk) {
        Write-Host ''
        Write-Host 'UNINSTALL PARTIAL - destination left absent; all content preserved in the paths above.'
        Write-SelectiveReloadNotice
        return
    }
    $restoredFrom = $previousBackupPath
} elseif (-not [string]::IsNullOrEmpty($previousBackupPath)) {
    Write-Warning "manifest recorded a prior backup that no longer exists on disk: $previousBackupPath"
}

# --- Manifest update (reference cleared so repeated runs converge) ------

# The manifest may be absent (e.g. a hand-installed destination); every
# recorded field degrades to $null instead of failing mandatory binding.
$prevManifest = $manifest
if ($null -eq $prevManifest) { $prevManifest = [PSCustomObject]@{} }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$updated = [PSCustomObject]@{
    version                 = 1
    kind                    = 'pi-telegram-bridge-global-extension-manifest'
    extensionName           = (Get-SelectiveGlobalExtensionName)
    moduleRoot              = (Get-BridgeModuleRoot)
    destination             = $destination
    stateDirectory          = (Get-SelectiveManifestField -Manifest $prevManifest -Name 'stateDirectory')
    files                   = (Get-SelectiveManifestField -Manifest $prevManifest -Name 'files')
    generatedEntry          = 'index.ts'
    previousBackupPath      = $null
    lastUninstallArchive    = $archivePath
    restoredFrom            = $restoredFrom
    sid                     = $identity.User.Value
    user                    = $identity.Name
    installedAt             = (Get-SelectiveManifestField -Manifest $prevManifest -Name 'installedAt')
    uninstalledAt           = (Get-Date).ToUniversalTime().ToString('o')
}
Write-SelectiveManifest -Manifest $updated

Write-Host ''
Write-Host 'UNINSTALL OK - global extension removed from auto-discovery.'
if ($null -ne $restoredFrom) {
    Write-Host "Rolled back to the prior installation from: $restoredFrom"
} else {
    Write-Host 'No prior backup was recorded; the destination is now absent.'
}
Write-Host "Archive (never deleted): $archivePath"
Write-SelectiveReloadNotice
