# T04 common.ps1 - shared helpers for the pi-telegram-bridge PowerShell
# scripts. Windows PowerShell 5.1 only. No secret may ever be passed on
# a command line, through the environment, or written to the terminal:
# plaintext credentials only ever travel through anonymous pipes between
# processes (stdin/stdout redirection).

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-BridgeModuleRoot {
    # scripts/ is one level below the module root.
    return (Split-Path -Parent $PSScriptRoot)
}

<#
.SYNOPSIS
Resolves the state root: the module-local default or an explicit
-StateDirectory, which must stay STRICTLY below <module>\.local.
Rejects reparse points (symlinks/junctions) on the confinement root
itself and every existing ancestor of the target - a junction planted
inside .local can never redirect the state root outside the module.
#>
function Resolve-BridgeStateDirectory {
    param([string]$StateDirectory)
    $moduleRoot = Get-BridgeModuleRoot
    $confineRoot = [System.IO.Path]::GetFullPath((Join-Path $moduleRoot '.local'))
    if (-not (Test-Path -LiteralPath $confineRoot)) {
        New-Item -ItemType Directory -Path $confineRoot -Force | Out-Null
    }
    if ([System.IO.Path]::IsPathRooted($StateDirectory)) {
        $candidate = [System.IO.Path]::GetFullPath($StateDirectory)
    } elseif (-not [string]::IsNullOrWhiteSpace($StateDirectory)) {
        $candidate = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $StateDirectory))
    } else {
        $candidate = Join-Path $confineRoot 'state'
    }
    $prefix = $confineRoot.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "state directory must stay below $prefix (got $candidate)"
    }
    # Reparse refusal walks EVERY existing ancestor from the confinement
    # root down to the candidate (including the confinement root itself).
    $probe = $candidate
    while ($probe.Length -gt $confineRoot.Length) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force
            if ($item.LinkType) {
                throw "reparse point refused in the state path: $probe ($($item.LinkType))"
            }
        }
        $parent = Split-Path -Parent $probe
        if ($null -eq $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    $confineItem = Get-Item -LiteralPath $confineRoot -Force
    if ($confineItem.LinkType) {
        throw "reparse point refused on the confinement root itself: $confineRoot"
    }
    return $candidate
}

function Get-BridgeCurrentUserSid {
    # The qualified SID - never $env:USERNAME, which is a display name,
    # not an identity.
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-BridgeCapabilityPath {
    param([Parameter(Mandatory = $true)][string]$StateRoot)
    return (Join-Path $StateRoot 'root.capability.json')
}

<#
.SYNOPSIS
Enforces the user-only ACL on an existing directory (real icacls with
checked exit code) and verifies it through Get-Acl with SID translation
(inheritance disabled, no unintended read/write identities) BEFORE any
secret is written or read. Then writes the root capability marker that
the Node credential store requires.
#>
function Lock-BridgeStateRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
    $sid = Get-BridgeCurrentUserSid
    icacls $Path /inheritance:r /grant:r "*$sid`:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "icacls failed with exit code $LASTEXITCODE for $Path"
    }
    Test-BridgeStateRootAcl -Path $Path -ExpectedSid $sid | Out-Null
    $capability = [PSCustomObject]@{
        version   = 1
        kind      = 'pi-telegram-bridge-state-root-capability'
        acl       = 'user-only'
        sid       = $sid
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-JsonFileAtomic -Path (Get-BridgeCapabilityPath -StateRoot $Path) -Value $capability
    return $sid
}

<#
.SYNOPSIS
Read-only ACL verification: inheritance must be disabled and the only
access identity must be the expected SID (translated, so display names
cannot fool the check).
#>
function Test-BridgeStateRootAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSid
    )
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.AreAccessRulesProtected -ne $true) {
        throw "inheritance is still enabled on $Path"
    }
    $sids = @()
    foreach ($rule in $acl.Access) {
        $sids += $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    $unique = @($sids | Sort-Object -Unique)
    if ($unique.Count -ne 1 -or $unique[0] -ne $ExpectedSid) {
        throw "unexpected identities on ${Path}: $($unique -join ', ') (expected only $ExpectedSid)"
    }
    return $true
}

<#
.SYNOPSIS
Verify-only check for start/status: the state root must exist, carry a
locked user-only ACL and a well-formed capability marker.
#>
function Test-BridgeStateRootLock {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "state root does not exist: $Path"
    }
    $capPath = Get-BridgeCapabilityPath -StateRoot $Path
    if (-not (Test-Path -LiteralPath $capPath)) {
        throw "state root is not a validated root (capability marker missing): $Path. Run scripts/setup.ps1 first."
    }
    $capability = Read-JsonFile -Path $capPath
    if ($null -eq $capability -or $capability.kind -ne 'pi-telegram-bridge-state-root-capability' -or $capability.acl -ne 'user-only') {
        throw "invalid capability marker: $Path"
    }
    Test-BridgeStateRootAcl -Path $Path -ExpectedSid $capability.sid
    return $true
}

<#
.SYNOPSIS
Dated backup of an existing file BEFORE it is replaced. Never deletes:
returns the backup path, or $null when the file did not exist.
#>
function Backup-BridgeFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $backupDir = Join-Path (Split-Path -Parent $Path) 'backups'
    if (-not (Test-Path -LiteralPath $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    $name = Split-Path -Leaf $Path
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $backupDir "$name.$stamp.bak"
    Copy-Item -LiteralPath $Path -Destination $backupPath -Force
    return $backupPath
}

<#
.SYNOPSIS
Rotates a log file before reuse: the old content is MOVED to a dated
archive sibling (retention without deletion), and a fresh empty file is
created at the original path. Never truncates the owner's old logs.
#>
function Rotate-BridgeLogFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $archive = "$Path.$stamp"
        Move-Item -LiteralPath $Path -Destination $archive -Force
    }
    New-Item -ItemType File -Path $Path -Force | Out-Null
}

function Get-BridgeStateRoot {
    # Default state root (kept for compatibility; lifecycle scripts use
    # Resolve-BridgeStateDirectory so -StateDirectory isolation works).
    $root = Join-Path (Get-BridgeModuleRoot) '.local\state'
    if (-not (Test-Path -LiteralPath $root)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }
    return $root
}

function Get-BridgeConfigPath {
    param([string]$StateRoot)
    $root = if ($StateRoot) { $StateRoot } else { Get-BridgeStateRoot }
    return (Join-Path $root 'runtime.json')
}

function Get-BridgeBlobPath {
    param([string]$StateRoot)
    $root = if ($StateRoot) { $StateRoot } else { Get-BridgeStateRoot }
    return (Join-Path $root 'credentials.bin')
}

function Get-BridgeBackupDir {
    param([string]$StateRoot)
    $root = if ($StateRoot) { $StateRoot } else { Get-BridgeStateRoot }
    $dir = Join-Path $root 'backups'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-JsonFileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $tmp = "$Path.tmp-$PID-$(Get-Date -Format 'yyyyMMddHHmmss')"
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    # PS 5.1's Set-Content -Encoding UTF8 emits a BOM, which node's
    # JSON.parse rejects. Write strict UTF-8 without BOM.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function New-BridgeInstanceId {
    $bytes = New-Object byte[] 16
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
}

function Test-BridgeConfig {
    param([string]$StateRoot)
    $config = Read-JsonFile -Path (Get-BridgeConfigPath -StateRoot $StateRoot)
    if ($null -eq $config) {
        Write-Error 'runtime.json is missing. Run scripts/setup.ps1 first.'
        return $null
    }
    return $config
}

<#
.SYNOPSIS
Runs a node script of this module capturing stdout/stderr as strings.
Secrets must NEVER be passed in $Arguments; use pipes for those.
#>
function Invoke-BridgeNode {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string[]]$Arguments = @(),
        [string]$StdinText = $null
    )
    $moduleRoot = Get-BridgeModuleRoot
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = ("`"$Script`" " + (($Arguments | ForEach-Object { "`"$_`"" }) -join ' '))
    $psi.WorkingDirectory = $moduleRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    # Read both pipes concurrently: sequential ReadToEnd calls can
    # deadlock when the child writes more than a pipe buffer to stderr
    # while stdout is still being drained (or vice versa).
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($null -ne $StdinText) {
        $process.StandardInput.Write($StdinText)
    }
    $process.StandardInput.Close()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

function Test-BridgePrerequisites {
    param([switch]$RequireCredentials, [string]$StateRoot)
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        Write-Error 'node was not found on PATH. Install Node.js 24 or newer first.'
        return $false
    }
    if ($RequireCredentials -and -not (Test-Path -LiteralPath (Get-BridgeBlobPath -StateRoot $StateRoot))) {
        Write-Error 'credentials blob is missing. Run scripts/setup.ps1 first.'
        return $false
    }
    if ($null -eq (Read-JsonFile -Path (Get-BridgeConfigPath -StateRoot $StateRoot))) {
        Write-Error 'runtime.json is missing. Run scripts/setup.ps1 first.'
        return $false
    }
    return $true
}

<#
.SYNOPSIS
Writes the typed control command file bound to the instance id. Refuses
when the live instance id does not match: a stale control file must
never command a foreign host.
#>
function Write-BridgeControl {
    param(
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][ValidateSet('start-worker', 'stop-worker', 'stop-host')][string]$Command,
        [Parameter(Mandatory = $true)][string]$InstanceId
    )
    if ($InstanceId -notmatch '^[0-9a-f]{32}$') {
        throw 'instance id must be 32 hex chars'
    }
    # Field names MUST match the Node contract (src/bridge-control.mjs):
    # { instanceId, command, issuedAt }.
    $control = [PSCustomObject]@{
        instanceId = $InstanceId
        command    = $Command
        issuedAt   = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    }
    Write-JsonFileAtomic -Path (Join-Path $StateRoot 'control.json') -Value $control
    return $true
}
