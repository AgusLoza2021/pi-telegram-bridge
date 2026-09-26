# Agent instructions

## Sending an image to the owner's Telegram

`scripts/send-photo.mjs` is the supported way to send one image from this PC to
the owner's private Telegram chat. Reach for your shell tool:

```
node scripts/send-photo.mjs "<path>" [--caption "text"]
```

- Run it from the project root.
- The image must be `.png`, `.jpg`, `.jpeg`, or `.webp`, at most 10 MB, and
  inside the project folder. For an image stored elsewhere, add
  `--root "<folder>"`.
- It prints exactly one final line: `SENT`, `DRY-RUN OK`, or `FAILED: <code>`.
  A failure prints one short code, never a traceback. Add `--dry-run` to
  validate a path without sending anything.
- The destination is not a parameter and cannot be influenced: a real send
  always goes to the enrolled private chat.
- Never pass, print, log, or paste the bot token. The command accepts no token
  argument, and the token never reaches process arguments or the environment.

`--help` prints the full contract. Do not reimplement its checks: the
extension allowlist, the size cap, and the folder containment check all live
in `src/media-policy.mjs`.

Contributions and local conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).
