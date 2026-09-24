# T05 selective-extension-common.ps1 - shared helpers for the global
# (auto-discovery) installation of the inert selective-TUI Pi extension.
# Windows PowerShell 5.1+. Dot-sources the bridge-wide helpers and adds
# ONLY the global-extension contract on top:
#
# - The ONLY allowed global destination is the exact dedicated
#   subdirectory <profile>\.pi\agent\extensions\pi-telegram-bridge.
#   Other global extensions and Pi's settings.json are never touched.
# - The user profile is resolved canonically through .NET
#   (GetFolderPath), never through $env:USERPROFILE, which can be
#   redirected or spoofed per-process.
# - Every component of the destination chain below the profile is
#   checked for reparse points (symlinks/junctions), the classic
#   Windows escape hatch, before anything is written.
# - Files are always written BOM-free (PS 5.1's Set-Content -Encoding
#   UTF8 emits a BOM that breaks TypeScript import resolution).
# - Nothing here ever deletes anything: backups and staging leftovers
#   are preserved and reported, never removed.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

<#
.SYNOPSIS
The fixed, dedicated global extension directory name. By design a
constant: install/uninstall may only ever touch this exact name under
the Pi extensions root, never a discovered or wildcarded one.
#>
function Get-SelectiveGlobalExtensionName {
    return 'pi-telegram-bridge'
}

<#
.SYNOPSIS
Canonical user profile path. GetFolderPath asks Windows for the real
profile location instead of trusting the environment block.
#>
function Get-SelectiveUserProfile {
    $profile_ = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($profile_)) {
        throw 'could not resolve the canonical user profile path'
    }
    return ([System.IO.Path]::GetFullPath($profile_).TrimEnd('\'))
}

<#
.SYNOPSIS
The Pi global auto-discovery root: <profile>\.pi\agent\extensions.
Created on demand (install only); callers that must stay read-only use
Test-Path themselves. The chain below the profile is reparse-checked
BEFORE creation and re-checked AFTER (another process must not be able
to swap in a junction between the check and the write).
#>
function Get-SelectiveExtensionsRoot {
    param([switch]$Create)
    $root = Join-Path (Get-SelectiveUserProfile) '.pi\agent\extensions'
    if ($Create) {
        Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $root
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            New-Item -ItemType Directory -Path $root -Force | Out-Null
        }
        Assert-SelectiveNoReparseBelow -Anchor (Get-SelectiveUserProfile) -Target $root
    }
    return $root
}

<#
.SYNOPSIS
The ONLY global destination this tooling may ever write:
<extensions root>\pi-telegram-bridge. The chain below the profile is
reparse-checked on every call (destination included when it exists).
#>
function Get-SelectiveGlobalExtensionDir {
    param([switch]$CreateRoot)
    return (Join-Path (Get-SelectiveExtensionsRoot -Create:$CreateRoot) (Get-SelectiveGlobalExtensionName))
}

<#
.SYNOPSIS
Refuses reparse points on EVERY existing component from (but not
including) $Anchor down to and including $Target. Mirrors the
confinement philosophy of scripts/common.ps1 Resolve-BridgeStateDirectory.
#>
function Assert-SelectiveNoReparseBelow {
    param(
        [Parameter(Mandatory = $true)][string]$Anchor,
        [Parameter(Mandatory = $true)][string]$Target
    )
    $anchorFull = [System.IO.Path]::GetFullPath($Anchor).TrimEnd('\')
    $targetFull = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
    $prefix = $anchorFull + '\'
    if (-not $targetFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "target '$targetFull' is not below anchor '$anchorFull'"
    }
    $probe = $targetFull
    while ($probe.Length -gt $anchorFull.Length) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force
            if ($item.LinkType) {
                throw "reparse point refused in the global extension path: $probe ($($item.LinkType))"
            }
        }
        $parent = Split-Path -Parent $probe
        if ($null -eq $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
}

<#
.SYNOPSIS
Backup root for the global extension: <module>\.local\backups\global-
extension. Created on demand (mutating scripts only); entries are NEVER
deleted - the audit trail is preserved by construction.
#>
function Get-SelectiveBackupRoot {
    param([switch]$Create)
    $dir = Join-Path (Get-BridgeModuleRoot) '.local\backups\global-extension'
    if ($Create -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Get-SelectiveManifestPath {
    return (Join-Path (Get-BridgeModuleRoot) '.local\global-extension-manifest.json')
}

<#
.SYNOPSIS
The self-contained payload: only the sources the installed extension
needs, mirrored at their ORIGINAL relative layout so the copied
extension file's '../src/*.mjs' imports keep resolving unchanged and
the deployed bytes equal the source bytes (hash-verifiable).
#>
function Get-SelectivePayloadMap {
    $moduleRoot = Get-BridgeModuleRoot
    return @(
        [PSCustomObject]@{
            RelativePath   = 'extension/selective-tui-extension.ts'
            DestinationRel = 'extension\selective-tui-extension.ts'
            SourcePath     = (Join-Path $moduleRoot 'extension\selective-tui-extension.ts')
        },
        [PSCustomObject]@{
            RelativePath   = 'src/tui-bridge-client.mjs'
            DestinationRel = 'src\tui-bridge-client.mjs'
            SourcePath     = (Join-Path $moduleRoot 'src\tui-bridge-client.mjs')
        },
        [PSCustomObject]@{
            RelativePath   = 'src/beginner-copy.mjs'
            DestinationRel = 'src\beginner-copy.mjs'
            SourcePath     = (Join-Path $moduleRoot 'src\beginner-copy.mjs')
        },
        [PSCustomObject]@{
            RelativePath   = 'src/store.mjs'
            DestinationRel = 'src\store.mjs'
            SourcePath     = (Join-Path $moduleRoot 'src\store.mjs')
        }
    )
}

function Test-SelectivePayloadPresent {
    foreach ($entry in Get-SelectivePayloadMap) {
        if (-not (Test-Path -LiteralPath $entry.SourcePath -PathType Leaf)) {
            throw "required source file is missing: $($entry.SourcePath)"
        }
    }
    return $true
}

function Get-SelectiveSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
.SYNOPSIS
Builds the generated entry file content. Contains PATHS ONLY (state
directory absolute path) - never credentials, tokens, Telegram ids or
session ids. Uses the official default-export entry convention
(docs/extensions.md) and the factory call shape required by T05.
#>
function New-SelectiveIndexContent {
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    $escaped = $StateDirectory.Replace('\', '\\').Replace("'", "\'")
    return @"
// GENERATED FILE - do not edit. Created by
// scripts/install-selective-extension.ps1
// (T05 safe global installation). Re-run the installer to regenerate.
//
// Inert by default: this entry registers /tg plus the advanced
// /telegram-connect, /telegram-disconnect and /telegram-status aliases.
// A fresh Pi process starts DISCONNECTED; nothing connects to the broker
// or Telegram until the user runs /tg locally inside an interactive TUI.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSelectiveTuiExtension } from './extension/selective-tui-extension.ts';

export default function (pi: ExtensionAPI): void {
  createSelectiveTuiExtension({
    stateDirectory: '$escaped',
  }).register(pi);
}
"@
}

function Write-SelectiveTextNoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrEmpty($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

<#
.SYNOPSIS
Safe field read for manifest objects parsed from disk (StrictMode-safe;
a truncated or foreign file degrades to $null instead of throwing).
#>
function Get-SelectiveManifestField {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $property = $Manifest.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Read-SelectiveManifest {
    $path = Get-SelectiveManifestPath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $manifest = Read-JsonFile -Path $path
    if ($null -eq $manifest) { return $null }
    $kind = Get-SelectiveManifestField -Manifest $manifest -Name 'kind'
    if ($kind -ne 'pi-telegram-bridge-global-extension-manifest') { return $null }
    return $manifest
}

function Write-SelectiveManifest {
    param([Parameter(Mandatory = $true)]$Manifest)
    Write-JsonFileAtomic -Path (Get-SelectiveManifestPath) -Value $Manifest
}

<#
.SYNOPSIS
Defuses auto-discovery for a directory that is about to be moved away:
renames its index.ts entry so that, even while the dot-prefixed
sibling sits under the extensions root, Pi's '*/index.ts' discovery
pattern cannot load it. Non-fatal: the dot-prefix already avoids the
documented discovery globs.
#>
function Protect-SelectiveEntryFile {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Suffix
    )
    $entry = Join-Path $Directory 'index.ts'
    if (Test-Path -LiteralPath $entry -PathType Leaf) {
        Rename-Item -LiteralPath $entry -NewName "index.ts.$Suffix"
    }
}

<#
.SYNOPSIS
Complete, verifying copy of a directory's contents (including hidden
files) into an existing target directory. Throws when the copy does
not match the source (file count and total bytes) so a caller never
trusts a partial backup.
#>
function Copy-SelectiveDirectoryContents {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target
    )
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
    }
    $sourceStats = Get-ChildItem -LiteralPath $Source -Recurse -Force -File |
        Measure-Object -Property Length -Sum
    $targetStats = Get-ChildItem -LiteralPath $Target -Recurse -Force -File |
        Measure-Object -Property Length -Sum
    if ([int64]$sourceStats.Count -ne [int64]$targetStats.Count -or
        [int64]$sourceStats.Sum -ne [int64]$targetStats.Sum) {
        throw ("verified copy failed: source has {0} files/{1} bytes, copy has {2} files/{3} bytes" -f `
            $sourceStats.Count, $sourceStats.Sum, $targetStats.Count, $targetStats.Sum)
    }
}

<#
.SYNOPSIS
Shared reload/inert notice printed by install and uninstall: running Pi
instances must /reload; NEW Pi instances auto-discover the extension and
start disconnected until the owner turns the phone connection on and
links the window with /tg.
#>
function Write-SelectiveReloadNotice {
    Write-Host ''
    Write-Host 'NOTE: already-running Pi instances need /reload to pick up this change.'
    Write-Host 'New Pi instances auto-discover the extension and start DISCONNECTED:'
    Write-Host 'nothing connects to Telegram until you turn the phone connection on, either with "telegram on" or with the start offer at the end of an advanced setup,'
    Write-Host 'and /tg links this window once it is on.'
}
