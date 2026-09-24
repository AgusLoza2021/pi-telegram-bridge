# Pi Telegram Bridge advanced guide

This guide covers manual operation, diagnostics, lifecycle scripts, and the preserved legacy runtime. Most users need only [`Setup Pi Telegram.cmd`](../Setup%20Pi%20Telegram.cmd) and `/tg`; start with the [README](../README.md) if you have not completed the guided setup.

## Advanced Telegram commands

These commands work only in the enrolled private chat. Session arguments use short IDs such as `tg:xxx`; the beginner interface uses readable labels instead.

| Command | Effect |
|---|---|
| `/help` | Show command help. |
| `/sessions` | List live connected Pi sessions. |
| `/use <shortId>` | Select the active Pi session. |
| `/status [shortId]` | Request status from the selected or named session. |
| `/send [shortId] <text>` | Prompt an idle session. |
| `/steer [shortId] <text>` | Redirect the current turn. |
| `/followup [shortId] <text>` | Queue a follow-up after the current turn. |
| `/abort [shortId]` | Abort the current turn. |
| `/disconnect [shortId]` | Disconnect that Pi session. |
| Plain text | Prompt the selected session. |

The router fails closed: prompt lines beginning with `/` are refused, unknown or ambiguous IDs are never guessed, stale selections must be selected again, and unknown commands show help.

Telegram receives bounded, safely chunked final assistant output and explicit command results. It does not receive model reasoning, token-by-token output, or raw tool-call transcripts.

## Advanced Pi commands

The beginner `/tg` command maps to these per-window commands:

| Command | Effect |
|---|---|
| `/telegram-connect [label]` | Link this Pi window and optionally assign a readable label. |
| `/telegram-disconnect` | Disconnect this Pi window and clear its local opt-in marker. |
| `/telegram-status` | Show this window's bridge state, short ID, label, process, directory, and session. |

Multiple linked Pi windows remain independently addressable. One Pi process never owns or terminates another. A dead or stale process is not reported as live.

## Manual setup

Run the advanced interactive setup directly from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
```

You can also run `npm run setup` from the repository root.

The advanced flow performs these stages:

1. **Protect the state directory.** It creates `.local/state/`, applies a user-only Windows ACL, and verifies the result before any secret exists.
2. **Write nonsecret runtime identity.** It writes `runtime.json` with the validated instance ID and selective bridge mode. Existing configuration is backed up before replacement.
3. **Enroll.** It reads the token with hidden input, validates the bot, refuses active webhooks, and pairs through a locally rendered QR code by default. The QR contains only the validated bot username and a fresh 128-bit nonce. Manual numeric ID entry is available as an advanced fallback. An explicit `ENROLL` confirmation is required before the atomic DPAPI credential commit.
4. **Offer local installation.** It can install the global Pi extension and register the current-user scheduled task (always registered disabled); registration never enables it, and setup asks once at the end whether to turn the connection on, with No as the default. Unlike the beginner launcher, these choices are presented individually.

Abort before confirmation and the previous credentials and configuration remain unchanged.

### Preparation only

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -PrepareOnly
```

`-PrepareOnly` performs the state protection and nonsecret runtime preparation only. It never prompts for credentials, performs enrollment, installs components, or starts the broker.

### Requirements

- Windows PowerShell 5.1 or later
- Node.js 24 or later
- An interactive Windows user session
- The pinned `qrcode-terminal` dependency installed with the repository

The QR renderer is local-only computation. It does not call an online QR service.

## Broker service lifecycle

The dedicated scheduled task is named `PiTelegramBridgeBroker`. It runs as the current interactive user with limited privileges, stores no Windows password, and pins the exact Node.js executable and repository paths captured at installation.

The task is registered **disabled** by whichever setup path registers it: the Beginner path never enables or starts it, and the advanced path only asks once at the end whether to turn the connection on, with No as the default. Nothing starts at a sign-in unless you turn it on: with `telegram on`, or by answering yes to that single setup question. The enable bit is the connection switch: `telegram on` enables and starts the task, `telegram off` stops it and clears the bit again, and once it is off it stays off across sign-ins and restarts until you turn it on again.

Once enabled, the task:

- starts at user logon and when explicitly requested;
- does not stop when the PC leaves Task Scheduler's idle state;
- has no execution-time limit;
- ignores duplicate start requests while one instance is running;
- can retry an unexpected failure up to three times at one-minute intervals.

```powershell
telegram on                           # enable the task and start the broker; fails closed if credentials are missing
telegram off                          # graceful stop, then disable, so the connection stays off across sign-ins
telegram status                       # read-only: is the connection on, and is the broker live?
scripts/status-broker-service.ps1     # task state and credential-free broker health; add -Json for scripts
scripts/start-broker-service.ps1      # enable and start; wait for a fresh heartbeat; reuse a live broker
scripts/stop-broker-service.ps1       # request graceful instance-bound shutdown, then disable; never kill an arbitrary PID
scripts/uninstall-broker-service.ps1  # graceful stop, dated XML backup, remove only this task
```

The scripts are idempotent and reversible. They do not delete credentials, state, logs, or backups.

## Extension lifecycle

```powershell
scripts/status-selective-extension.ps1
scripts/install-selective-extension.ps1
scripts/uninstall-selective-extension.ps1
```

Installation stages a fixed four-file runtime payload, verifies hashes, rejects reparse-point escapes, writes a generated state-directory binding, and backs up any prior dedicated installation. Uninstall restores that prior installation when available and does not modify Pi settings.

Already-running Pi windows need `/reload` after installation or removal. New windows discover the extension automatically and still start disconnected.

## State, logs, and backups

All mutable bridge data is kept under the git-ignored `.local/` directory:

- `.local/state/` — encrypted credentials, nonsecret runtime identity, SQLite transport, broker heartbeat metadata, and runtime logs
- `.local/backups/` — dated configuration, task XML, and extension backups
- `.local/logs/` — setup dependency logs

The protected state directory is restricted to the current Windows user. Backups are never pruned or deleted automatically.

The SQLite transport uses durable command claims and acknowledgements. A broker event is acknowledged only after all Telegram chunks have been sent successfully.

## Uninstall and rollback

### Remove the running integration

```powershell
scripts/stop-broker-service.ps1
scripts/uninstall-broker-service.ps1
scripts/uninstall-selective-extension.ps1
```

Then type `/reload` in any open Pi window.

This removes only the dedicated scheduled task and extension installation. Credentials, runtime state, logs, and dated backups remain under `.local/` so the operation is reversible.

### Restore an earlier installation

Every replacement of runtime configuration, the scheduled task, or the global extension creates a dated backup first. Restore the appropriate backup manually, or run setup again to create a fresh supported installation. No rollback script deletes current data automatically.

### Revoke the Telegram token

Use BotFather → `/mybots` → your bot → **API Token** → **Revoke current token**. The old token stops working immediately. Run setup again to enroll the replacement token.

## Legacy headless mode

The older Pi-owned host/worker runtime remains available only through an explicit flag:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -LegacyHeadless
scripts/start.ps1
scripts/status.ps1
scripts/stop.ps1
```

Legacy mode keeps Pi CLI and workspace discovery, host/worker supervision, and the approval queue. It shares the protected state root, encrypted credential blob, and instance identity with selective mode, but uses its stricter legacy runtime configuration shape.

The default selective broker never creates, spawns, or owns Pi processes. Do not use legacy mode unless you specifically need the old headless workflow.

## Developer verification

```powershell
node --test tests/*.test.mjs
scripts/test.ps1
scripts/smoke-windows.ps1   # optional operator smoke check
```

The full test suite covers durable transport, selective TUI behavior, beginner routing, enrollment and QR validation, Windows ACL and DPAPI policy, runtime configuration, lifecycle scripts, the launcher, legacy compatibility, and end-to-end fake transports.

For the component boundaries and trust model, continue with [Architecture](ARCHITECTURE.md). Contribution requirements are in [CONTRIBUTING.md](../CONTRIBUTING.md).
