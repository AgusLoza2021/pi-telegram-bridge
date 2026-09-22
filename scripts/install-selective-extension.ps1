# T05 install-selective-extension.ps1 - safe global installation of the
# inert selective-TUI Pi extension under the current user's Pi
# auto-discovery directory (~\.pi\agent\extensions\pi-telegram-bridge).
# Windows PowerShell 5.1+. SOURCE ONLY: this session must not execute
# the installer; running it is a separate authorized local step (T07).
#
# Guarantees:
# - The ONLY global destination is the exact dedicated subdirectory
#   pi-telegram-bridge under <profile>\.pi\agent\extensions (canonical
#   profile via .NET, reparse-checked chain). Other global extensions
#   and Pi's settings.json are never read or written.
# - Idempotent: re-running replaces the destination. The complete prior
#   contents are first copied to a timestamped backup under
#   <module>\.local\backups\global-extension\; backups are NEVER deleted.
# - Staging: all new files are written into a dot-prefixed sibling with
#   a DEFERRED entry name (index.ts.pending), then swapped in with
#   same-volume renames. The documented Pi discovery globs
#   ('*.ts', '*/index.ts') can therefore never observe a half-written
#   active extension: the entry name only exists once the directory is
#   renamed into place.
# - Files are BOM-free; deployed bytes are SHA-256 verified against the
#   sources before the swap.
# - Nonsecret manifest at <module>\.local\global-extension-manifest.json:
#   source/destination/state paths, install time, source hashes and the
#   exact prior backup path. No token, no Telegram ids, no session ids,
#   no credentials.
# - The installed extension stays INERT: this script starts no process,
#   never touches the broker or the scheduled task, and the extension
#   connects nothing until /tg is run locally.

param(
    [string]$StateDirectory
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'selective-extension-common.ps1')

Test-SelectivePayloadPresent | Out-Null

$moduleRoot = Get-BridgeModuleRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# Confined state directory for the generated entry: the SAME root the
# broker uses (<module>\.local\state), so the extension's SQLite handle
# is the shared durable transport. Confinement and reparse checks come
# from the existing bridge helpers; ACLs are never weakened here.
$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
}
$capPath = Get-BridgeCapabilityPath -StateRoot $stateRoot
if (Test-Path -LiteralPath $capPath) {
    # Setup ran before this install: verify the user-only lock still holds.
    Test-BridgeStateRootLock -Path $stateRoot | Out-Null
} else {
    Write-Host 'NOTE: scripts/setup.ps1 has not run for this state root yet;'
    Write-Host 'the extension stays inert (no broker, no Telegram) until enrollment.'
}

# Canonical destination with a reparse-checked chain below the profile
# (the destination directory itself is included when it exists, so a
# planted junction can never be replaced through).
$extensionsRoot = Get-SelectiveExtensionsRoot -Create
$destination = Join-Path $extensionsRoot (Get-SelectiveGlobalExtensionName)
Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $destination

if (Test-Path -LiteralPath $destination) {
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
        throw "destination exists but is not a directory: $destination"
    }
}

# --- Backup of the current installation (never deleted) -----------------

$previousBackupPath = $null
$replacedDir = $null
if (Test-Path -LiteralPath $destination) {
    $backupRoot = Get-SelectiveBackupRoot -Create
    $backupPath = Join-Path $backupRoot $stamp
    New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    Copy-SelectiveDirectoryContents -Source $destination -Target $backupPath
    $previousBackupPath = $backupPath
    Write-Host "Prior installation backed up to: $backupPath"
}

# --- Staging (dot-prefixed sibling, deferred entry name) ----------------

$staging = Join-Path $extensionsRoot ".pi-telegram-bridge.staging-$stamp"
New-Item -ItemType Directory -Path $staging -Force | Out-Null
# A pre-planted junction at the staging name must never be written through.
Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $staging

foreach ($entry in Get-SelectivePayloadMap) {
        $targetPath = Join-Path $staging $entry.DestinationRel
        $targetParent = Split-Path -Parent $targetPath
        if (-not (Test-Path -LiteralPath $targetParent -PathType Container)) {
            New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $entry.SourcePath -Destination $targetPath -Force
        if ((Get-SelectiveSha256 -Path $entry.SourcePath) -ne (Get-SelectiveSha256 -Path $targetPath)) {
            throw "staged copy does not match source: $($entry.SourcePath)"
        }
    }

    # Generated entry keeps its deferred name until the swap, so the
    # staging sibling is never discoverable as a Pi extension.
    Write-SelectiveTextNoBom -Path (Join-Path $staging 'index.ts.pending') `
        -Content (New-SelectiveIndexContent -StateDirectory $stateRoot)

    # --- Atomic-as-possible swap (same-volume renames) ------------------

    if (Test-Path -LiteralPath $destination) {
        # Defuse discovery of the outgoing directory, then move it aside
        # with a same-volume rename (single atomic operation).
        Protect-SelectiveEntryFile -Directory $destination -Suffix 'replaced'
        $replacedDir = Join-Path $extensionsRoot ".pi-telegram-bridge.replaced-$stamp"
        Move-Item -LiteralPath $destination -Destination $replacedDir
    }
    try {
        if (Test-Path -LiteralPath $destination) {
            # A foreign process must not race the swap: refuse and roll back.
            throw "destination reappeared unexpectedly during the swap: $destination"
        }
        Rename-Item -LiteralPath (Join-Path $staging 'index.ts.pending') -NewName 'index.ts'
        Move-Item -LiteralPath $staging -Destination $destination
    } catch {
        # Rollback: the outgoing installation is still intact as the
        # dot-prefixed sibling; put it back before failing.
        if ($null -ne $replacedDir -and (Test-Path -LiteralPath $replacedDir)) {
            Move-Item -LiteralPath $replacedDir -Destination $destination -Force
            # The pre-move defuse renamed the outgoing entry to
            # index.ts.replaced; restore its live name on rollback.
            if (Test-Path -LiteralPath (Join-Path $destination 'index.ts.replaced')) {
                Rename-Item -LiteralPath (Join-Path $destination 'index.ts.replaced') -NewName 'index.ts'
            }
        }
        throw
    }
# A failed install leaves the (non-discoverable) staging leftovers in
# place for inspection; nothing is ever deleted here.

# --- Disposition of the moved-aside previous installation ---------------

if ($null -ne $replacedDir -and (Test-Path -LiteralPath $replacedDir)) {
    try {
        # File it under the timestamped backup (cross-volume move). If
        # this fails, the dot-prefixed sibling is left in place and
        # reported - it is inert and non-discoverable, never deleted.
        $replacedTarget = Join-Path $previousBackupPath 'replaced-original'
        New-Item -ItemType Directory -Path $replacedTarget -Force | Out-Null
        Get-ChildItem -LiteralPath $replacedDir -Force | ForEach-Object {
            Move-Item -LiteralPath $_.FullName -Destination $replacedTarget -Force
        }
        # Husk removal only: non-recursive, so it succeeds only when every
        # child was moved under the backup; otherwise it fails and the
        # leftovers are reported, never destroyed.
        Remove-Item -LiteralPath $replacedDir -Force | Out-Null
    } catch {
        Write-Warning ("could not fully file the replaced installation under the backup; leftovers are preserved (inert, non-discoverable) at: $replacedDir")
    }
}

# --- Nonsecret install manifest ------------------------------------------

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$fileRecords = @()
foreach ($entry in Get-SelectivePayloadMap) {
    $fileRecords += [PSCustomObject]@{
        relativePath = $entry.RelativePath
        sourcePath   = $entry.SourcePath
        sha256       = (Get-SelectiveSha256 -Path $entry.SourcePath)
    }
}
$manifest = [PSCustomObject]@{
    version            = 1
    kind               = 'pi-telegram-bridge-global-extension-manifest'
    extensionName      = (Get-SelectiveGlobalExtensionName)
    moduleRoot         = $moduleRoot
    destination        = $destination
    stateDirectory     = $stateRoot
    files              = $fileRecords
    generatedEntry     = 'index.ts'
    previousBackupPath = $previousBackupPath
    sid                = $identity.User.Value
    user               = $identity.Name
    installedAt        = (Get-Date).ToUniversalTime().ToString('o')
}
Write-SelectiveManifest -Manifest $manifest

Write-Host ''
Write-Host 'INSTALL OK - global extension deployed (inert until local /tg).'
Write-Host "Destination: $destination"
Write-Host "State:       $stateRoot"
if ($null -ne $previousBackupPath) {
    Write-Host "Prior backup: $previousBackupPath (never deleted)"
}
Write-Host "Manifest:    $(Get-SelectiveManifestPath)"
Write-SelectiveReloadNotice
