# Contributing

Thanks for helping make Pi easier to use from a phone. Keep changes small, reviewable, and inside the security boundaries documented in [SECURITY.md](SECURITY.md).

Participation in this project is covered by the [Code of conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements:

- Windows 11;
- Windows PowerShell 5.1;
- Node.js 24 or newer;
- a local Pi installation for manual acceptance only.

From a fresh checkout, install the single pinned production dependency without package lifecycle scripts:

```powershell
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
```

Run the automated gates:

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
```

These commands exercise unit, integration, static PowerShell, launcher, and security-boundary tests. Ordinary contributors should **not** run setup, enrollment, service-install, service-start, or Telegram smoke scripts as part of automated verification; those commands mutate real user state and belong to explicit manual acceptance.

Before changing public behavior, read the [architecture](docs/ARCHITECTURE.md), [advanced operating guide](docs/ADVANCED.md), and exact [beginner UX contract](docs/BEGINNER_UX.md).

## Change rules

- Preserve exact user-and-chat authorization, private-chat-only routing, outbound polling, DPAPI CurrentUser, ACL confinement, and process-local `/tg` opt-in.
- Remote input may call only typed Pi operations. Never add CMD, PowerShell, shell, arbitrary process, MCP, or generic tool execution from Telegram.
- Send only finalized assistant text. Never forward hidden reasoning, tool calls/results, context, or token deltas.
- Never place tokens, IDs, QR/nonces, prompts, outputs, credentials, databases, logs, manifests, or real absolute user paths in source, fixtures, issues, screenshots, or commits.
- Keep dependency versions locked. New dependencies need a concrete reason, license review, and install-script review.
- Keep beginner copy free of infrastructure jargon; retain advanced controls in their dedicated documentation.
- Add or update tests with behavior. Do not weaken an assertion to hide a production defect.

## Pull requests

Use a focused branch and Conventional Commit messages. Describe the user-visible outcome, security-boundary impact, and exact checks run. List skipped manual checks honestly. Do not add generated state (`.local/`), `node_modules/`, credentials, logs, databases, or editor artifacts.

Pull requests are expected to be green on the same gates that CI runs on `windows-latest` (`.github/workflows/ci.yml`): `npm test` and `scripts/test.ps1`.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
