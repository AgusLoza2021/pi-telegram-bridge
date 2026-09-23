# Security policy

`pi-telegram-bridge` controls explicitly linked Pi sessions from one authorized Telegram private chat. Security reports are welcome and should never expose the data the bridge is designed to protect.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** flow for this repository. Do not open a public issue for a suspected authentication bypass, remote-command path, secret disclosure, unauthorized session access, hidden-reasoning leak, public listener, or privilege-escalation problem.

Include only the smallest sanitized reproduction needed to understand the issue. Never include:

- a Telegram bot token;
- Telegram user or chat identifiers;
- QR images, pairing links, or pairing nonces;
- `credentials.bin`, `runtime.json`, `bridge.sqlite`, install manifests, or `.local/` contents;
- raw logs, terminal history, private prompts, Pi outputs, or screenshots containing personal data;
- absolute paths containing a real username or private project name.

If a bot token may have been exposed, revoke it immediately with BotFather before doing anything else. Stop the bridge locally, create a replacement token, and run setup again. Do not send the revoked token to maintainers.

## Security boundaries

The supported design intentionally provides:

- outbound Telegram long polling only — no webhook, public listener, or open inbound port;
- exact enrolled Telegram user **and** private-chat authorization;
- Windows DPAPI CurrentUser protection and a user-only ACL for local credentials and state;
- explicit `/tg` opt-in for every Pi process; a new process starts disconnected;
- typed Pi prompt, steer, follow-up, abort, and disconnect operations — never a generic shell;
- finalized assistant text only — no hidden reasoning, tool calls, tool results, context, or token stream;
- one-time local QR pairing with a fresh nonce; the QR never contains the bot token;
- no approval or consent fabrication.

Changes that weaken any boundary above are security-sensitive and require explicit tests and review.

## Supported environment

Version 1 targets Windows 11, Windows PowerShell 5.1, Node.js 24 or newer, Telegram private chats, and current Pi releases compatible with the extension API used by this repository. Until tagged releases exist, only the latest `main` revision is supported.

## Non-security reports

Use the public bug form for sanitized reproducible defects that do not cross a security boundary. Feature requests, copy improvements, unsupported operating systems, and general setup questions are not private vulnerability reports.

## Code of conduct

Behaviour in this project's spaces is covered by the [Code of conduct](CODE_OF_CONDUCT.md), which routes reports through the private channel defined in this file.
