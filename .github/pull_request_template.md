## Summary

Describe the user-visible outcome and why the change is needed.

## Security boundaries

- [ ] Exact Telegram user + private-chat authorization is preserved.
- [ ] No remote shell, arbitrary process, MCP, or generic tool execution was added.
- [ ] Finalized assistant text remains the only Pi content sent to Telegram.
- [ ] No token, ID, QR/nonce, credential, database, log, prompt/output, manifest, or real user path is included.
- [ ] New dependencies, if any, are justified and their license/install behavior was reviewed.

## Verification

List the exact commands and results. State skipped manual checks explicitly.

- [ ] `npm test`
- [ ] `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1`
- [ ] Manual setup/service/Telegram checks were either not needed or are described below.
