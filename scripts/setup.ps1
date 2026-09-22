# T06 setup.ps1 - OWNER-RUN interactive setup for the bridge runtime.
# Windows PowerShell 5.1 only. Interactive on purpose: enrollment and
# credential capture must never be automated.
#
# DEFAULT (selective live-TUI mode): prepares the ACL-locked state root,
# writes the NONSECRET runtime instance config (NO pi CLI/workspace
# discovery is required - the broker never spawns or owns Pi), then runs
# the masked DPAPI enrollment flow. Enrollment defaults to LOCAL QR
# PAIRING: the bot username is captured from check-bot, a fresh 128-bit
# nonce is generated locally, src/qr-render.mjs prints a QR + deep link
# (https://t.me/<bot>?start=<nonce> - NEVER containing the token), and
# pair-start waits up to 60 seconds for the exact private-chat
# "/start <nonce>" message, deriving the user/chat ids automatically.
# Manual numeric id entry remains an explicit fallback when the owner
# declines the QR or pairing fails. After a SUCCESSFUL selective
# enrollment it OFFERS - locally, via explicit prompts - the dedicated
# installers for the global (inert) Pi extension and the current-user
# broker scheduled task, and optionally starts the broker.
# -PrepareOnly never installs or starts anything.
#
# -LegacyHeadless: the pre-T06 headless flow, preserved verbatim as an
# explicit fallback (pi CLI/workspace discovery, followups flag, legacy
# runtime.json shape). The legacy host/worker lifecycle scripts
# (start.ps1/status.ps1/stop.ps1) keep working against that shape.
#
# ORDER MATTERS (acceptance fix): the state root is created and locked
# (real icacls + verified through Get-Acl, capability marker written)
# BEFORE any secret is captured, protected or read. The credential blob
# is written ATOMICALLY and only AFTER bot verification, nonce pairing
# and an explicit typed confirmation - a failed run preserves any
# previously committed credentials. runtime.json is always backed up
# (dated) before it is replaced; previous credentials/config are never
# destroyed.
#
# Modes:
#   -PrepareOnly     discover nothing, write the NONSECRET runtime.json
#                    and lock the state root. No credential prompt, no
#                    network, NO install, NO service start. Prints
#                    "PREPARE OK".
#   (default)        everything above + interactive enrollment + optional
#                    local extension/service installation offers.
#   -LegacyHeadless  the legacy headless enrollment (pi CLI/workspace +
#                    followups flag + legacy runtime.json shape); with
#                    -PrepareOnly it keeps the old prepare-only behavior.
#
# The script never writes .env files, never autostarts anything by
# itself, and never sends anything to Telegram except
# getMe/getWebhookInfo/getUpdates. No credential is ever passed as an
# argument: the token travels through stdin pipes only. The QR payload
# is username+nonce ONLY and never contains the bot token; the nonce is
# generated locally and never sent anywhere except inside the deep link
# the owner scans themselves.

param(
    [switch]$PrepareOnly,
    [switch]$LegacyHeadless,
    [switch]$Beginner,
    [string]$StateDirectory,
    [string]$PiCliPath,
    [string]$PiWorkspace
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

# Beginner is intentionally launcher-only. Reject incompatible modes before
# resolving or creating the state root so an invalid invocation cannot mutate
# local state.
if ($Beginner -and ($PrepareOnly -or $LegacyHeadless)) {
    Write-Host 'This setup option cannot be combined with advanced modes.'
    exit 2
}

if ($Beginner) {
    Write-Host 'Let''s connect Pi to Telegram.'
} else {
    $modeLabel = if ($LegacyHeadless) { 'legacy headless mode' } else { 'selective live-TUI mode' }
    Write-Host "=== pi-telegram-bridge setup (local, interactive) - $modeLabel ==="
}

# --- node check -------------------------------------------------------------
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node was not found on PATH. Install Node.js 24 or newer first.'
}

# --- state root: confined + ACL-locked BEFORE any secret exists --------------
$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$capabilitySid = Lock-BridgeStateRoot -Path $stateRoot
if (-not $Beginner) {
    Write-Host "State root locked (user-only ACL, SID $capabilitySid): $stateRoot"
}

$blobPath = Get-BridgeBlobPath -StateRoot $stateRoot
$backupDir = Get-BridgeBackupDir -StateRoot $stateRoot
$configPath = Get-BridgeConfigPath -StateRoot $stateRoot

# Runs a dedicated setup/lifecycle script of this module in a fresh
# powershell process. Arguments carry PATHS ONLY - never credentials.
# Returns the child exit code; a failure is reported, never swallowed.
function Invoke-SetupSubscript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string]$ScriptStateDirectory,
        [string]$QuietLogPath
    )
    $path = Join-Path $PSScriptRoot $ScriptName
    if (-not (Test-Path -LiteralPath $path)) {
        if ([string]::IsNullOrWhiteSpace($QuietLogPath)) {
            Write-Warning "missing script: $path"
        }
        return 1
    }
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path)
    if (-not [string]::IsNullOrWhiteSpace($ScriptStateDirectory)) {
        $argv += @('-StateDirectory', $ScriptStateDirectory)
    }
    if ([string]::IsNullOrWhiteSpace($QuietLogPath)) {
        & powershell.exe @argv
    } else {
        $quietLogDirectory = Split-Path -Parent $QuietLogPath
        New-Item -ItemType Directory -Path $quietLogDirectory -Force | Out-Null
        & powershell.exe @argv *>> $QuietLogPath
    }
    return $LASTEXITCODE
}

# LEGACY interactive enrollment (used by -LegacyHeadless only): masked
# token capture, manual numeric id entry, bot verification, optional
# legacy nonce pairing, typed ENROLL confirmation, atomic DPAPI commit.
# Nothing is written on abort or failure; the previous blob/config stay
# intact. The selective (default) flow lives in Invoke-SelectiveEnrollment.
function Invoke-BridgeEnrollment {
    Write-Host ''
    Write-Host 'Step 1/3: bot credentials (kept in memory until you confirm).'
    $secure = Read-Host -Prompt 'Bot token (masked)' -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $tokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ([string]::IsNullOrWhiteSpace($tokenPlain)) { throw 'token is required' }

    $userId = Read-Host 'Your numeric Telegram user id (from @userinfobot)'
    $chatId = Read-Host 'The chat id the bridge must use (same number or a group id)'
    if ($userId -notmatch '^\d+$') { throw 'user id must be numeric' }
    if ($chatId -notmatch '^-?\d+$') { throw 'chat id must be numeric' }

    Write-Host ''
    Write-Host 'Step 2/3: verifying the bot (getMe + webhook check).'
    $check = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\enroll.mjs') `
        -Arguments @('check-bot') -StdinText $tokenPlain
    if ($check.ExitCode -ne 0) {
        throw "bot verification failed: $($check.StdOut.Trim())"
    }
    Write-Host 'Bot verified; no webhook is configured.'

    Write-Host ''
    Write-Host 'Step 3/3: identity check (recommended).'
    $pairOk = $false
    $doPair = Read-Host 'Verify your id by sending a one-time phrase to the bot now? (Y/n)'
    if ($doPair -notmatch '^[nN]') {
        $nonce = "bridge-pair $script:InstanceId"
        Write-Host ''
        Write-Host "Send EXACTLY this message to your bot in a PRIVATE chat, then press Enter:"
        Write-Host "  $nonce"
        Read-Host 'Press Enter after sending (or just Enter to skip)' | Out-Null
        $pair = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\enroll.mjs') `
            -Arguments @('pair', '--nonce', $nonce, '--duration-ms', '60000') `
            -StdinText $tokenPlain
        if ($pair.ExitCode -eq 0 -and $pair.StdOut -match '^CANDIDATES:(.+)$') {
            # Candidate ids are shown ONLY here, on the owner's local console.
            $candidates = $Matches[1].Split(',') | ForEach-Object { $_.Trim() }
            if ($candidates.Count -eq 1 -and $candidates[0] -eq $userId) {
                Write-Host 'Identity confirmed: the nonce sender matches your id.'
                $pairOk = $true
            } else {
                Write-Warning "The nonce sender(s) ($($candidates -join ', ')) do NOT match the id you typed ($userId)."
            }
        } else {
            Write-Warning "Pairing did not complete ($($pair.StdOut.Trim()))."
        }
    }

    Write-Host ''
    if (-not $pairOk) {
        Write-Warning 'Pairing did not confirm your identity. The bot token itself was verified, but never trust a first sender.'
    }
    $confirm = Read-Host "Type ENROLL to commit these credentials to the DPAPI blob (anything else aborts)"
    if ($confirm -ne 'ENROLL') {
        # Nothing was written: any previously committed blob/config is intact.
        Write-Host 'Aborted. No credential was committed; the previous state is preserved.'
        exit 3
    }

    $credentialJson = @{
        botToken      = $tokenPlain
        allowedUserId = $userId
        allowedChatId = $chatId
    } | ConvertTo-Json -Compress
    $tokenPlain = $null            # drop the local copy; the blob is authoritative
    [System.GC]::Collect()         # best effort; DPAPI blob is the real store

    $protect = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\dpapi-credentials.mjs') `
        -Arguments @('protect', '--blob', $blobPath, '--backup-dir', $backupDir) `
        -StdinText $credentialJson
    $credentialJson = $null
    if ($protect.ExitCode -ne 0) {
        throw "credential protection failed: $($protect.StdErr.Trim())"
    }
    Write-Host 'Credentials committed atomically (DPAPI, current user, verified state root).'
}

# SELECTIVE (default) interactive enrollment with LOCAL QR PAIRING:
# 1. masked token capture; 2. check bot/webhook and capture the bot
# username; 3. QR choice (default Y); 4. fresh 128-bit nonce generated
# locally; 5. src/qr-render.mjs renders the QR + deep link (username +
# nonce ONLY - never the token); 6. pair-start polls up to 60 seconds
# for the exact private-chat "/start <nonce>" with the token on stdin
# only; 7. user/chat ids are derived automatically and shown ONLY on the
# owner's local console; 8. typed ENROLL before the DPAPI commit. Manual
# numeric id entry is the explicit fallback when the owner declines the
# QR or pairing fails - a failed pairing NEVER trusts a first sender.
function Invoke-SelectiveEnrollment {
    Write-Host ''
    if ($Beginner) {
        Write-Host 'Paste the token BotFather gave you. It stays hidden.'
    } else {
        Write-Host 'Step 1/4: bot credentials (kept in memory until you confirm).'
    }
    $secure = Read-Host -Prompt 'Bot token (masked)' -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $tokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ([string]::IsNullOrWhiteSpace($tokenPlain)) {
        if ($Beginner) {
            Write-Host 'Your private link was not changed. Run setup again when you have the BotFather token.'
            exit 3
        }
        throw 'token is required'
    }

    Write-Host ''
    if ($Beginner) {
        Write-Host 'Checking your bot...'
    } else {
        Write-Host 'Step 2/4: verifying the bot (getMe + webhook check).'
    }
    $check = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\enroll.mjs') `
        -Arguments @('check-bot') -StdinText $tokenPlain
    if ($check.ExitCode -ne 0) {
        if ($Beginner) {
            Write-Host 'I could not verify that bot. Check the token and your internet connection, then run setup again.'
            exit 4
        }
        throw "bot verification failed: $($check.StdOut.Trim())"
    }
    if ($check.StdOut -notmatch '^OK:([A-Za-z][A-Za-z0-9_]{4,31})\r?\n?$') {
        if ($Beginner) {
            Write-Host 'The bot answered unexpectedly. Run setup again in a moment.'
            exit 4
        }
        throw 'bot verification returned an unexpected output shape'
    }
    $botUsername = $Matches[1]
    if ($Beginner) {
        Write-Host "Found @$botUsername."
    } else {
        Write-Host "Bot verified: @$botUsername (no webhook is configured)."
    }

    $userId = $null
    $chatId = $null

    Write-Host ''
    if ($Beginner) {
        Write-Host 'Open your phone camera and scan the code below. Telegram will open your bot; tap Start.'
        $useQr = ''
    } else {
        Write-Host 'Step 3/4: pairing (QR recommended).'
        $useQr = Read-Host 'Show a pairing QR code to scan from your Telegram app now? (Y/n)'
    }
    if ($useQr -notmatch '^[nN]') {
        # Fresh 128-bit nonce, generated LOCALLY (never sent anywhere except
        # inside the deep link below). The QR/deep link payload is the
        # username + nonce ONLY: the token never reaches qr-render, argv,
        # the environment, logs or files.
        $nonce = New-BridgeInstanceId
        # T10 fix: the QR block is pure Unicode box-drawing characters. When
        # routed through the generic captured Invoke-BridgeNode pipes, the
        # captured bytes were decoded as a legacy Windows code page and shown
        # as mojibake (e.g. "Γ..."). For THIS step only, invoke the known
        # node executable DIRECTLY with the known qr-render.mjs script and
        # argv of validated username + fresh nonce only, so stdout stays
        # attached to the owner's Windows Terminal (native Unicode) instead
        # of a captured pipe. No stdin, no token, no environment secrets:
        # the QR payload is structurally username + nonce ONLY. Fail closed
        # on a nonzero exit; the captured exit code is the only channel checked.
        #
        # T10 hardening (round 2): PowerShell 5.1 defaults [Console]::OutputEncoding
        # to the legacy OEM code page (IBM437 on the owner's machine), so even a
        # DIRECT node invocation gets its Unicode box characters decoded and
        # re-encoded as the same Γ-mojibake while flowing through PowerShell.
        # For THIS step only, temporarily switch the console output encoding to
        # BOM-less UTF-8 around the invocation and restore the original encoding
        # in finally - the change is never permanent. The child exit code is
        # captured INSIDE try (into $qrExitCode) so it survives the restore, and
        # the fail-closed fallback below checks $qrExitCode, not $LASTEXITCODE.
        $qrScriptPath = Join-Path (Get-BridgeModuleRoot) 'src\qr-render.mjs'
        $qrPreviousOutputEncoding = [Console]::OutputEncoding
        $qrExitCode = 1
        try {
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            & node $qrScriptPath '--username' $botUsername '--nonce' $nonce
            $qrExitCode = $LASTEXITCODE
        } finally {
            [Console]::OutputEncoding = $qrPreviousOutputEncoding
        }
        if ($qrExitCode -ne 0) {
            if ($Beginner) {
                Write-Host 'I could not show the QR code. Run setup again; your private link is safe.'
                exit 4
            }
            Write-Warning 'QR rendering failed; falling back to manual id entry.'
        } else {
            # Print the QR and its deep link immediately, then pair. The link
            # interpolates ${botUsername} BRACED: an unbraced "$botUsername?start"
            # makes PowerShell 5.1 parse "botUsername?start" as one variable
            # name (VariableIsUndefined).
            Write-Host ''
            if ($Beginner) {
                Write-Host 'Waiting for your phone for up to one minute...'
            } else {
                Write-Host "Scan the QR (or open https://t.me/${botUsername}?start=$nonce), then send"
                Write-Host 'the /start message if the bot asks for it. Waiting up to 60 seconds...'
            }
            $pair = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\enroll.mjs') `
                -Arguments @('pair-start', '--nonce', $nonce, '--duration-ms', '60000') `
                -StdinText $tokenPlain
            if ($pair.ExitCode -eq 0 -and $pair.StdOut -match '^PAIRED:(\d+):(\d+)\r?\n?$') {
                $userId = $Matches[1]
                $chatId = $Matches[2]
                # Derived ids are shown only in the advanced setup surface.
                if ($Beginner) {
                    Write-Host 'Your phone is linked.'
                } else {
                    Write-Host "Paired: authorized user id $userId, chat id $chatId (private chat)."
                }
            } else {
                if ($Beginner) {
                    Write-Host 'The QR code expired or was not confirmed. Run setup again for a fresh code; your private link is safe.'
                    exit 4
                }
                Write-Warning "Pairing did not complete ($($pair.StdOut.Trim())); falling back to manual id entry."
            }
        }
    } else {
        Write-Host 'QR declined; manual id entry will be used.'
    }

    if ($null -eq $userId) {
        if ($Beginner) {
            Write-Host 'Setup needs the QR connection. Run it again when your phone is ready.'
            exit 4
        }
        Write-Host ''
        Write-Host 'Manual fallback: enter the ids yourself (from @userinfobot).'
        $userId = Read-Host 'Your numeric Telegram user id'
        $chatId = Read-Host 'The chat id the bridge must use (same number or a group id)'
    }
    if ($userId -notmatch '^\d+$') { throw 'user id must be numeric' }
    if ($chatId -notmatch '^-?\d+$') { throw 'chat id must be numeric' }

    Write-Host ''
    if ($Beginner) {
        Write-Host 'Last step: confirm this private link.'
        $confirm = Read-Host 'Type ENROLL to save it on this PC (anything else cancels)'
    } else {
        Write-Host 'Step 4/4: commit (typed confirmation).'
        $confirm = Read-Host "Type ENROLL to commit these credentials to the DPAPI blob (anything else aborts)"
    }
    if ($confirm -ne 'ENROLL') {
        # Nothing was written: any previously committed blob/config is intact.
        if ($Beginner) {
            Write-Host 'Cancelled. Your previous link and settings are unchanged.'
        } else {
            Write-Host 'Aborted. No credential was committed; the previous state is preserved.'
        }
        exit 3
    }

    $credentialJson = @{
        botToken      = $tokenPlain
        allowedUserId = $userId
        allowedChatId = $chatId
    } | ConvertTo-Json -Compress
    $tokenPlain = $null            # drop the local copy; the blob is authoritative
    [System.GC]::Collect()         # best effort; DPAPI blob is the real store

    $protect = Invoke-BridgeNode -Script (Join-Path (Get-BridgeModuleRoot) 'src\dpapi-credentials.mjs') `
        -Arguments @('protect', '--blob', $blobPath, '--backup-dir', $backupDir) `
        -StdinText $credentialJson
    $credentialJson = $null
    if ($protect.ExitCode -ne 0) {
        if ($Beginner) {
            Write-Host 'I could not save the private link. Your previous settings are unchanged.'
            exit 5
        }
        throw "credential protection failed: $($protect.StdErr.Trim())"
    }
    if ($Beginner) {
        Write-Host 'Your secure link was saved on this PC.'
    } else {
        Write-Host 'Credentials committed atomically (DPAPI, current user, verified state root).'
    }
}

# --- instance id: keep the committed one on re-runs (idempotent setup) --------
$script:InstanceId = New-BridgeInstanceId
$existingConfig = Read-JsonFile -Path $configPath
$existingIsLegacyShape = $false
if ($null -ne $existingConfig) {
    $existingId = $existingConfig.PSObject.Properties['instanceId']
    if ($null -ne $existingId -and "$($existingId.Value)" -match '^[0-9a-f]{32}$') {
        $script:InstanceId = $existingId.Value
    }
    $existingIsLegacyShape = $null -ne $existingConfig.PSObject.Properties['pi']
}

# --- dated backup BEFORE replacing runtime.json (never delete, never lose) ----
$previousConfigBackup = Backup-BridgeFile -Path $configPath

if ($LegacyHeadless) {
    # ------------------------------------------------------------------
    # LEGACY HEADLESS FLOW (explicit fallback, pre-T06 behavior).
    # ------------------------------------------------------------------

    # --- pi discovery ---------------------------------------------------------
    function Resolve-PiInputs {
        param([string]$CliPath, [string]$WorkspacePath)
        $piCli = $CliPath
        if ([string]::IsNullOrWhiteSpace($piCli)) {
            $piCli = Read-Host 'Absolute path to the pi CLI entry (e.g. C:\Users\you\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js)'
        }
        if (-not (Test-Path -LiteralPath $piCli)) { throw "pi CLI not found at $piCli" }
        $piWorkspace_ = $WorkspacePath
        if ([string]::IsNullOrWhiteSpace($piWorkspace_)) {
            $piWorkspace_ = Read-Host 'Absolute path of the pi workspace (project) the bridge controls'
        }
        if (-not (Test-Path -LiteralPath $piWorkspace_)) { throw "workspace not found at $piWorkspace_" }
        return @{ Cli = $piCli; Workspace = $piWorkspace_ }
    }

    $pi = Resolve-PiInputs -CliPath $PiCliPath -WorkspacePath $PiWorkspace

    # Followup/task enabling stays EXPLICIT and defaults to false. -PrepareOnly
    # never enables it; the interactive run asks, and a later runtime.json edit
    # is the documented opt-in path for prepare-only installs.
    $followupsEnabled = $false
    if (-not $PrepareOnly) {
        $followupsAnswer = Read-Host 'Allow /followup while a dialog is open? (y/N)'
        $followupsEnabled = ($followupsAnswer -match '^[yY]')
    }

    $config = [PSCustomObject]@{
        version    = 1
        instanceId = $script:InstanceId
        pi         = [PSCustomObject]@{ cliPath = $pi.Cli; workspace = $pi.Workspace }
        bridge     = [PSCustomObject]@{ followupsEnabled = $followupsEnabled }
    }
    Write-JsonFileAtomic -Path $configPath -Value $config

    if ($PrepareOnly) {
        Write-Host ''
        Write-Host 'PREPARE OK'
        Write-Host "State root: $stateRoot"
        Write-Host 'Credentials were NOT touched. Run setup.ps1 again (without -PrepareOnly) to enroll.'
        exit 0
    }

    Invoke-BridgeEnrollment

    Write-Host ''
    Write-Host 'Setup complete (legacy headless mode).'
    Write-Host "State root: $stateRoot"
    Write-Host 'Next: run scripts/smoke-windows.ps1, then scripts/start.ps1 and scripts/status.ps1.'
    exit 0
}

# ------------------------------------------------------------------------------
# DEFAULT: SELECTIVE LIVE-TUI MODE.
# ------------------------------------------------------------------------------

# Nonsecret instance config: the broker needs ONLY the validated instance
# id and this state/config identity - no pi CLI, no workspace. If an
# earlier LEGACY config existed, it stays in the dated backup above and
# the legacy headless flow remains available via -LegacyHeadless (the
# credential blob is shared and never touched by this rewrite).
if ($existingIsLegacyShape) {
    if ($Beginner) {
        Write-Host 'Updating your previous setup safely...'
    } else {
        Write-Host ''
        Write-Host 'MIGRATION: the existing runtime.json was written in legacy headless shape.'
        if ($null -ne $previousConfigBackup) {
            Write-Host "The previous config was backed up (dated): $previousConfigBackup"
        }
        Write-Host 'It has been migrated to the selective shape below; the DPAPI credentials'
        Write-Host 'were preserved. Legacy headless stays available via setup.ps1 -LegacyHeadless.'
    }
}

$config = [PSCustomObject]@{
    version    = 1
    instanceId = $script:InstanceId
    bridge     = [PSCustomObject]@{ mode = 'selective' }
}
Write-JsonFileAtomic -Path $configPath -Value $config

if ($PrepareOnly) {
    Write-Host ''
    Write-Host 'PREPARE OK'
    Write-Host "State root: $stateRoot"
    Write-Host 'Credentials were NOT touched; nothing was installed or started.'
    Write-Host 'Run setup.ps1 again (without -PrepareOnly) to enroll.'
    exit 0
}

Invoke-SelectiveEnrollment

# The double-click Beginner path performs the three dedicated component steps
# only after explicit ENROLL. Child output is confined to the already locked,
# ignored local state tree; only paths are passed to the child scripts, never
# credentials or enrollment values. Stop on the first failure.
if ($Beginner) {
    Write-Host ''
    Write-Host 'Finishing setup...'
    $componentLog = Join-Path $stateRoot 'logs\setup-components.log'
    $componentScripts = @(
        'install-selective-extension.ps1',
        'install-broker-service.ps1',
        'start-broker-service.ps1'
    )
    foreach ($componentScript in $componentScripts) {
        $code = Invoke-SetupSubscript -ScriptName $componentScript `
            -ScriptStateDirectory $stateRoot -QuietLogPath $componentLog
        if ($code -ne 0) {
            exit $code
        }
    }
    exit 0
}

# --- post-enrollment offers (LOCAL prompts only; nothing automatic) ----------
# Calls go through the dedicated scripts with PATH-ONLY arguments; no
# credential ever appears in an argument, env var or file. -PrepareOnly
# never reaches this point, so a prepare-only run can never install or
# start anything globally.
Write-Host ''
Write-Host 'Optional local installation (you can also run these scripts later):'

$extensionAnswer = Read-Host 'Install the global Pi extension now (globally available but INERT until /tg)? (Y/n)' 
if ($extensionAnswer -notmatch '^[nN]') {
    $code = Invoke-SetupSubscript -ScriptName 'install-selective-extension.ps1' -ScriptStateDirectory $stateRoot
    if ($code -ne 0) {
        Write-Warning "the extension installer exited with code $code; run scripts/install-selective-extension.ps1 manually later."
    }
} else {
    Write-Host 'Skipped. Install later with scripts/install-selective-extension.ps1.'
}

$serviceAnswer = Read-Host 'Register the current-user broker scheduled task now (starts at logon; NOT started by registration)? (Y/n)'
$serviceInstalled = $false
if ($serviceAnswer -notmatch '^[nN]') {
    $code = Invoke-SetupSubscript -ScriptName 'install-broker-service.ps1' -ScriptStateDirectory $stateRoot
    if ($code -eq 0) {
        $serviceInstalled = $true
    } else {
        Write-Warning "the service installer exited with code $code; run scripts/install-broker-service.ps1 manually later."
    }
} else {
    Write-Host 'Skipped. Install later with scripts/install-broker-service.ps1.'
}

if ($serviceInstalled) {
    $startAnswer = Read-Host 'Start the broker now? (Y/n)'
    if ($startAnswer -notmatch '^[nN]') {
        $code = Invoke-SetupSubscript -ScriptName 'start-broker-service.ps1' -ScriptStateDirectory $stateRoot
        if ($code -ne 0) {
            Write-Warning "the start script exited with code $code; run scripts/start-broker-service.ps1 manually later."
        }
    } else {
        Write-Host 'Not started. Start later with scripts/start-broker-service.ps1 (it also starts at next logon).'
    }
}

# --- summary -------------------------------------------------------------------
Write-Host ''
Write-Host 'Setup complete (selective live-TUI mode).'
Write-Host "State root: $stateRoot"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  - In any interactive Pi TUI, use /tg to link or /tg off to unlink.'
Write-Host '  - Advanced aliases remain: /telegram-connect [label],'
Write-Host '    /telegram-disconnect and /telegram-status.'
Write-Host '  - From the authorized Telegram chat: /sessions, /use <shortId>,'
Write-Host '    /status, /send, /steer, /followup, /abort, /disconnect.'
Write-Host '    Plain text prompts the selected TUI; final outputs only.'
Write-Host '  - Service lifecycle: scripts/status-broker-service.ps1,'
Write-Host '    start-broker-service.ps1, stop-broker-service.ps1,'
Write-Host '    uninstall-broker-service.ps1.'
Write-Host '  - Extension lifecycle: scripts/status-selective-extension.ps1,'
Write-Host '    uninstall-selective-extension.ps1.'
Write-Host '  - Rollback / legacy headless: setup.ps1 -LegacyHeadless, then'
Write-Host '    scripts/start.ps1 / status.ps1 / stop.ps1.'
