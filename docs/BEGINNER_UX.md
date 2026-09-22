# Beginner UX Contract — Pi ⇄ Telegram on Windows 11 (T01)

Audience: non-technical users first, implementers second. This document is the **contract** for what a beginner sees and can do; every string in quotes is exact user-facing copy. It is documentation/design only — it adds no runtime behavior by itself. Section 13 maps each UX requirement to the existing safe operations it must be built on.

Conventions:

- `MSG-…` ids are stable copy references used by the acceptance matrix (§14) and future tests.
- "Beginner path" means: no Windows internals (encryption, services, tasks, permissions), no short session ids, no slash commands except `/tg` and `/start` unless the user opts into advanced mode (§11).
- V1 copy language: **English**. The friendly-label → operation mapping (§8) is written so a translation layer can replace strings later without changing behavior.

---

## 1. The happy path: three actions

1. **Create a Telegram bot.** In the Telegram app, talk to [@BotFather](https://t.me/BotFather), send `/newbot`, follow its two questions, and copy the token it gives you. (One-time, ~2 minutes.)
2. **Set up the PC.** Double-click **Setup Pi Telegram** on Windows, paste the token when asked, then scan the QR code shown on screen with the Telegram app on your phone.
3. **Link Pi and talk.** Open Pi on the PC, type `/tg`, confirm, then send an ordinary Telegram text message from your phone. Pi's answer arrives in the same chat.

Everything else in this document covers what happens off the happy path.

---

## 2. Voice and copy rules

- Short sentences, active voice, no blame ("Something didn't work", never "You failed").
- Never show, on the beginner path: `DPAPI`, `broker`, `scheduled task`, `ACL`, `short id` (`tg:…`), `pid`, `argv`, `SQLite`, `long poll`.
- Buttons always state the outcome ("Stop this task"), never the mechanism (`/abort`).
- Every error names the next action ("Press Enter to try again").
- Session names are **readable labels** (§5), e.g. `Pi · demo-project` — never `tg:xxx`.

---

## 3. Windows setup — state machine

Entry: the user double-clicks the setup launcher (a thin double-clickable wrapper that runs `scripts/setup.ps1`; the wrapper is an implementation delta, see §13). One window, one question at a time.

States: `NOT_ENROLLED → TOKEN_PROMPT → TOKEN_CHECK → QR_WAITING → (QR_EXPIRED ↺) → ENROLLED → SERVICE_RUNNING`; any step may enter `RECOVERABLE_FAILURE` and return to the failed step.

| State | Trigger | Exact copy / behavior |
|---|---|---|
| `NOT_ENROLLED` | Launcher opened, PC not linked yet | `MSG-S1`: "Welcome! This links your PC to your own Telegram bot so you can talk to Pi from your phone. Press Enter to start." |
| `NOT_ENROLLED` (already linked) | Launcher opened, PC already linked | `MSG-S2`: "This PC is already linked. Press Enter to keep the current link, or type RESET to start over." |
| `TOKEN_PROMPT` | User pressed Enter | `MSG-S3`: "Paste the token BotFather gave you (it looks like 123456789:AA…), then press Enter. It stays on this computer." Input masked; no echo. |
| `TOKEN_CHECK` | Token pasted | `MSG-S4`: "Checking your bot…". On success: `MSG-S5`: "Found your bot: @<botname>." |
| `TOKEN_CHECK` (invalid token) | Bot check fails | `MSG-S6`: "That token didn't work. Copy it again from BotFather (send /token to BotFather to see it) and paste it here." → stays in `TOKEN_PROMPT`. |
| `QR_WAITING` | Bot verified | `MSG-S7`: "Open the Camera app on your phone and point it at this code. Tap the Telegram link, then tap Start." QR rendered locally; below it: `MSG-S8`: "Waiting for your scan… (expires in 60 seconds)" with a live countdown. |
| `QR_EXPIRED` | 60 s elapsed without scan | `MSG-S9`: "The code expired. Press Enter for a new one." → fresh code, same `QR_WAITING` copy. Three consecutive expiries → `RECOVERABLE_FAILURE` with `MSG-E3`. |
| `ENROLLED` | Scan paired successfully | `MSG-S10`: "Done! Your PC and Telegram are linked." |
| `SERVICE_RUNNING` | Background link started | `MSG-S11`: "Your link is active and will start automatically each time you sign in to Windows. Open Pi, type /tg, and send a message from your phone." |
| `RECOVERABLE_FAILURE` | Any recoverable error (scan failed, network down, restart needed) | `MSG-E1`: "Something didn't work: <plain reason>. Nothing was changed — your previous settings are intact. Press Enter to try again, or close this window." Plain reasons from a fixed whitelist (§10); internal causes never surface by name. |

Hard rules:

- Abort or failure at any point leaves any previous link intact (atomic commit only on success).
- Setup never asks for, prints, or logs the token again after `TOKEN_PROMPT`.
- `MSG-S11` is the only place setup mentions automatic startup; it is phrased as "your link", never "service"/"task".

---

## 4. Pi `/tg` — state machine

`/tg` is the beginner alias of the existing opt-in connect command. **Every Pi process stays disconnected by default; nothing ever connects automatically.** The extension is present but inert until the user types `/tg` in that specific Pi window.

States: `DISCONNECTED → CONFIRM_PROMPT → CONNECTED`; `CONNECTED → DISCONNECT_PROMPT → DISCONNECTED`. `BUSY` is an annotation that changes copy, not reachability.

| State | Trigger | Exact copy / behavior |
|---|---|---|
| `DISCONNECTED` | `/tg` typed, this Pi not linked | `MSG-C1` (confirmation prompt): "Link this Pi window to Telegram? You'll be able to send it messages from your phone and it will reply there. [Connect] [Cancel]" |
| `CONNECTED` | User chose Connect and the PC phone connection has a fresh matching heartbeat | `MSG-C2`: "Linked. Send a message from your phone — this Pi (Pi · <label>) will answer. Type /tg off to unlink." The label is auto-derived: project folder name (§5). |
| `CONNECTED_LOCAL_ONLY` | User chose Connect but the PC phone connection is missing, stale, shut down, foreign or dead | `MSG-C2B`: "Linked, but the phone connection on this PC isn't running right now. Restart Windows, then send your message again. This Pi will stay linked." The local link remains active so routing recovers automatically when the PC connection returns. |
| `CONNECTED` | `/tg` typed while linked and the PC phone connection is live | `MSG-C3`: "This Pi is linked as 'Pi · <label>' (currently <state>). Type /tg off to unlink." (idempotent status, no re-confirmation) |
| `CONNECTED_LOCAL_ONLY` | `/tg` typed while linked but the PC phone connection is unavailable | `MSG-C3B`: "This Pi is linked as 'Pi · <label>', but the phone connection on this PC isn't running right now. Restart Windows, then try again." |
| `BUSY` (annotation on connect) | `/tg` confirm while a task is running | Confirm copy appended: `MSG-C4`: "Note: this Pi is in the middle of a task. Its result will arrive on Telegram when it finishes." |
| `DISCONNECT_PROMPT` | `/tg off` typed while linked | `MSG-C5`: "Unlink this Pi from Telegram? [Unlink] [Cancel]" |
| `DISCONNECTED` (after unlink) | User chose Unlink | `MSG-C6`: "Unlinked. This window no longer talks to Telegram." |
| `DISCONNECT_PROMPT` (busy) | `/tg off` while a task is running | Copy appended: `MSG-C7`: "Warning: a task is still running here. Its result will NOT be sent to Telegram anymore. [Unlink anyway] [Cancel]" |
| (any) | `/tg` in a Pi with setup incomplete | `MSG-C8`: "Your PC isn't linked to Telegram yet. Double-click Setup Pi Telegram on your PC first, then come back here." |

Hard rules:

- No automatic connection, ever: a fresh Pi process is always `DISCONNECTED`, even after setup and even if other Pi windows are linked.
- Confirmation is required for connect **and** disconnect; busy variants of both exist.
- `/tg` and `/tg off` must also appear in Pi's command help; the long names (`/telegram-connect`, `/telegram-disconnect`, `/telegram-status`) remain valid and are documented as advanced (§11).

---

## 5. Readable labels (applies everywhere)

- Auto-derived label = project folder name the Pi window is working in: `Pi · demo-project`, `Pi · notes-app`.
- Collisions between simultaneously linked windows get an ordinal suffix in link order: `Pi · demo-project (2)`. The suffix is cosmetic and stable for the life of the link.
- Labels are what appear in every Telegram button and message. Short ids (`tg:xxx`) exist internally for addressing but **never appear in beginner copy** (they remain visible in advanced commands, §11).

---

## 6. Telegram `/start` home

What the user sees when they open the bot chat or send `/start` (also shown automatically the first time after pairing).

| Situation | Exact copy / behavior |
|---|---|
| Setup not finished | `MSG-T1`: "Hi! Your PC needs one more step: double-click Setup Pi Telegram on your PC, then come back here." |
| Linked, no live Pi | `MSG-T2`: "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg." |
| Exactly one live Pi | `MSG-T3`: "Connected to Pi · <label>. Just type a message and it goes to that Pi." — no buttons needed; the session is auto-selected. |
| Multiple live Pis | `MSG-T4`: "Which Pi should I talk to?" + one button per live session (`Pi · demo-project`, `Pi · notes-app`, …) + `[Refresh]`. Tapping a button selects that session for plain messages (§7) and re-sends `MSG-T3` naming it. No short ids anywhere. |
| Selected session disappeared | `MSG-T5`: "Pi · <label> just closed or disconnected. Pick another:" + same buttons as above (or `MSG-T2` if none left). Nothing the user typed is lost silently: a held prompt follows the rules in §7. |

Auto-selection rule: with exactly one live session, it is selected implicitly and `MSG-T3` says so. With multiple, **nothing is auto-selected** — plain text is held (§7) until the user picks.

---

## 7. Plain text routing

An ordinary text message (not starting with `/`) from the authorized user.

| Situation | Behavior / copy |
|---|---|
| One live Pi (auto-selected) | Direct dispatch. No prompt, no buttons. |
| Multiple live Pis, none selected | **Hold exactly one pending prompt.** Reply `MSG-P1`: "Your message is saved. Choose which Pi should get it:" + session buttons. Tapping a button dispatches the held text **once** to that Pi, then confirms `MSG-P2`: "Sent to Pi · <label>." |
| Second plain text while one is pending | The new text **replaces** the pending one (the older text is discarded, never dispatched). Re-show `MSG-P1` with the new text waiting. This keeps the invariant "at most one pending prompt, dispatched at most once". |
| No live Pi | `MSG-P3`: "There's no Pi connected right now. Open Pi on your PC and type /tg — then your messages will reach it. (Nothing was lost — send it again once Pi is linked.)" |
| Selected Pi is busy | Busy choice card (§8) — the text is held as the pending prompt until the user picks. |
| Session vanished between hold and choice | Tapping a dead session's button → `MSG-T5` (§6); the pending prompt stays pending for the next choice. |

Hard rules:

- Exactly-once: a pending prompt is dispatched exactly once, deduplicated across retries and duplicate callback presses; a second tap of the same button is a no-op that re-sends `MSG-P2`.
- The pending prompt's text is **never** echoed into button payloads (§10) and never dispatched to a session the user did not pick.

---

## 8. Busy choices

When the selected Pi is mid-task and the user acts (sends plain text, or taps **"This Pi is busy"** actions), the user gets friendly choices. The table below is the explicit implementer mapping; the left column is what the user sees, the right column the existing safe operation it maps to. The words *steer*, *follow-up* and *abort* are **not** shown to beginners.

| Button (user-facing, V1 English) | Maps to | Effect copy after tap |
|---|---|---|
| `Add my message for after this task` | follow-up (queue for running turn) | `MSG-B1`: "Got it — Pi · <label> will see your message right after the current task." |
| `Redirect the current task` | steer (inject into running turn) | `MSG-B2`: "Done — Pi · <label> got your message and will adjust what it's doing." |
| `Stop the task and use my message` | abort, then dispatch held prompt to the idle session | `MSG-B3`: "Stopped. Your message is on its way to Pi · <label>." |
| `Leave it alone` | no-op (cancel; held prompt discarded if one existed, else nothing) | `MSG-B4`: "Okay — I left Pi · <label> working." |

If there is no held prompt (user tapped busy actions without sending text), the card is: `MSG-B5`: "Pi · <label> is working on a task. What would you like to do?" + the four buttons above (the first three then prompt for text with `MSG-B6`: "Type your message and send it.").

Hard rules:

- Mapping is data, not prose: implementers bind each label to exactly one existing bridge operation; no new execution path is introduced.
- After any choice the card resolves; stale duplicate taps are no-ops (§10).

---

## 9. Final output card

Every finalized Pi answer arrives as a message followed by an action row. There is no streaming, no partial text, no hidden content.

Card shape (Telegram):

```
Pi · <label>

<final answer text>

Reply by just typing here · /help for more
[Change Pi]  [Disconnect]
```

| Button | Behavior |
|---|---|
| *(typing any text)* | "Reply" is implicit: a new plain text follows §7 routing to the same selected Pi. The card footer says so; there is no Reply button to press. |
| `Change Pi` | Re-sends `MSG-T4` (§6) with the live-session buttons. |
| `Disconnect` | `MSG-C5` equivalent, remotely: `MSG-O1`: "Unlink Pi · <label>? You can relink it any time from the PC. [Unlink] [Cancel]" |
| `Stop` | **Not on the final output card** (the task already ended). A `Stop this task` button appears only on interim cards that report a still-running task — e.g. the follow-up confirmation (`MSG-B1`) and steer confirmation (`MSG-B2`) carry `[Stop this task]` mapped to abort, confirming with `MSG-O2`: "Stopped. Pi · <label> is idle now." |

Delivery rules unchanged: bounded message size, safe chunking, final text only — no reasoning, no tool transcripts, no token stream.

---

## 10. Callback payload and authorization constraints

All beginner buttons are Telegram inline callbacks. Constraints, verifiable per callback:

1. **Bounded opaque ids only.** `callback_data` carries at most: an operation tag, a bounded opaque session reference (opaque token mapped server-side to the real short id; ≤ 32 chars), and, for the pending-prompt choice, a bounded opaque pending-prompt id (≤ 32 chars). No prompt text, no labels, no secrets, no tokens inside callbacks.
2. **Exact authorization.** Every callback and message is accepted only from the exact enrolled private chat id **and** enrolled user id (both must match); anything else is ignored silently.
3. **Idempotent / deduped.** Telegram `callback_id`s are answered exactly once; session-choice and pending-dispatch callbacks dedupe so a double-tap cannot dispatch twice or dispatch to two sessions. Command execution keeps the existing exactly-once claim discipline.
4. **No secrets or prompt text in transit metadata.** The held prompt text lives server-side only, keyed by the pending id; callbacks never contain it. The bot token never appears in any chat, log, callback or payload.
5. **Fail-closed.** Unknown operation tags, unknown/expired pending ids, dead session references, and callbacks from stale keyboards resolve with the matching friendly copy (`MSG-T5`, `MSG-P3`) — never with a guess, an error trace, or jargon.

---

## 11. Errors and the advanced escape hatch

Friendly errors follow the fixed-whitelist pattern: each known failure has one plain-English line plus a next action. Examples:

| Situation | Copy |
|---|---|
| PC unreachable (asleep/offline) | `MSG-E2`: "Pi isn't answering right now — is your PC awake? It can't reply while asleep or offline. Try again in a moment." |
| Repeated setup failure | `MSG-E3`: "Setup keeps failing. Check your internet connection and try again. If it still fails, the 'Fix problems' section of the guide on your PC has next steps." |
| Unknown `/`-command typed by a beginner | `MSG-E4`: "I didn't understand that. Send /help to see what I can do." (Lines starting with `/` inside a prompt remain refused, as today.) |
| Text sent to a dead session | `MSG-T5` (§6). |

**Advanced escape hatch.** `/help` always answers with a two-part reply: the three beginner sentences (talk to Pi by typing; type /tg on the PC to link; this chat is private to you), then an advanced block pointing to the full command documentation on the PC (`README.md` — Telegram commands table: `/sessions`, `/use`, `/status`, `/send`, `/steer`, `/followup`, `/abort`, `/disconnect`). All existing slash commands keep working unchanged for users who opt in; they are documented **separately** in the README and are never pushed onto the beginner path. Short ids appear only in that advanced layer.

---

## 12. Explicit non-goals (V1)

- **No generic command/shell surface.** No remote terminal, no CMD/PowerShell endpoint, no arbitrary command execution — remote input reaches Pi only through its official message/steer/follow-up/abort APIs.
- **No hidden reasoning or tool stream.** Final outputs only; no thinking content, no token-by-token streaming, no tool-call transcripts.
- **No auto-connect.** Setup links the PC; it never links a Pi process. Every Pi window connects only when the user types `/tg` in it, every time.
- **No public listener.** Outbound polling to Telegram only; nothing listens on the network, ever.
- **No multiplatform setup in V1.** Windows 11 only; no macOS/Linux setup flow, no cloud relay.
- **No beginner-visible ids or jargon.** Short ids, service/task/ACL/DPAPI wording stay in advanced documentation only.

---

## 13. Implementation mapping notes (deltas vs. today)

The UX contract rests on operations that already exist and are trusted: masked DPAPI enrollment with QR pairing in `setup.ps1`; inert-by-default extension with `/telegram-connect` / `/telegram-disconnect`; broker routing with exact dual-id authorization, durable dedup and exactly-once command claims; official Pi APIs for prompt/steer/follow-up/abort; bounded final-output delivery.

Gaps this contract requires implementers to close (all additive, none new-privileged):

1. A double-clickable Windows setup wrapper invoking `scripts/setup.ps1` unchanged.
2. A `/tg` / `/tg off` beginner alias with confirmation prompts and busy annotations in the extension, keeping the long commands intact.
3. Auto-derived readable labels (project folder + ordinal) stored with the session, used everywhere beginners see sessions.
4. Inline-keyboard home and action rows in the broker, with opaque bounded callback data per §10.
5. The single-pending-prompt hold-and-choose flow with exactly-once dispatch.
6. Beginner copy strings centralized (single source, English V1) so the §8/§14 mapping stays verifiable.

Nothing in this contract weakens existing guarantees: no secrets in chat/argv/logs, no shell endpoint, no listener, no auto-connect, final outputs only.

---

## 14. Acceptance matrix

Each row: observable state/event → required visible copy/action → the implementation surface that must satisfy it. "Delta" rows do not exist today and must be built; all others bind existing behavior to this copy.

| # | State / event | Copy / action | Implementation surface |
|---|---|---|---|
| A1 | Fresh setup launch | `MSG-S1` | Delta: double-click wrapper → `scripts/setup.ps1` welcome step |
| A2 | Token pasted, bot verified | `MSG-S4` then `MSG-S5` | `setup.ps1` enrollment (`getMe` verification) — copy delta |
| A3 | QR shown, 60 s window | `MSG-S7`, `MSG-S8` countdown | `src/qr-render.mjs` + `src/enroll.mjs` pairing — copy/countdown delta |
| A4 | QR expiry | `MSG-S9`, fresh code on Enter | `enroll.mjs` retry loop — copy delta |
| A5 | Enrollment committed | `MSG-S10` then `MSG-S11` | `setup.ps1` commit + optional broker start — copy delta |
| A6 | Recoverable setup failure | `MSG-E1` with whitelisted reason | `setup.ps1` error paths — copy delta; previous link preserved (existing atomic commit) |
| A7 | Pi `/tg` on disconnected window | `MSG-C1` confirm | Delta: `/tg` alias + confirmation over `extension/selective-tui-extension.ts` `/telegram-connect` |
| A8 | Confirm connect; label derived; phone connection live/unavailable | `MSG-C2` with `Pi · <folder>` label or `MSG-C2B` while preserving the local link | Extension connect using cwd folder name, collision ordinal and nonsecret broker heartbeat probe |
| A9 | `/tg` while connected | `MSG-C3` when live or `MSG-C3B` when unavailable | Extension idempotent status plus nonsecret broker heartbeat probe |
| A10 | `/tg off`, idle and busy variants | `MSG-C5`/`MSG-C6`; `MSG-C7` when busy | Extension disconnect + running-turn check — delta |
| A11 | `/start`, setup incomplete | `MSG-T1` | `src/selective-telegram-broker.mjs` home reply — delta |
| A12 | `/start`, no live session | `MSG-T2` | Broker sessions listing (existing store state) — copy delta |
| A13 | `/start`, exactly one live session | `MSG-T3`, auto-selected | Broker auto-select rule — delta |
| A14 | `/start`, multiple live sessions | `MSG-T4` + label buttons (no short ids) | Delta: inline keyboard; button data per §10 |
| A15 | Selected session disappeared | `MSG-T5` + repick buttons | Broker stale-selection handling (exists) — copy + keyboard delta |
| A16 | Plain text, one session | Direct dispatch, no copy | Existing plain-text routing |
| A17 | Plain text, multiple unselected | Hold one pending prompt; `MSG-P1`; dispatch once on choice; `MSG-P2` | Delta: pending-prompt hold keyed by opaque id; exactly-once dispatch |
| A18 | Second text while pending | Replace pending, re-show `MSG-P1` | Delta: pending replacement rule |
| A19 | Plain text, no session | `MSG-P3` | Existing no-session fail-closed path — copy delta |
| A20 | Text/act on busy session | §8 card + four buttons mapped to follow-up/steer/abort+send/cancel | Existing `/followup`/`/steer`/`/abort` ops — delta: busy detection + keyboard |
| A21 | Final output arrives | Card per §9 with `[Change Pi]` `[Disconnect]` | Existing bounded final-output delivery — delta: action row |
| A22 | `Stop` on interim busy card | `MSG-O2` via abort | Existing `/abort` op — delta: button binding |
| A23 | Any callback | §10 constraints 1–5 (opaque bounded ids, dual-id authorization, dedupe, no prompt text, fail-closed) | Broker callback handling + existing dual authorization + dedup store — delta: callback ops |
| A24 | Unauthorized sender/chat | Silent ignore | Existing exact user+chat authorization (unchanged) |
| A25 | Friendly errors | `MSG-E2`, `MSG-E3`, `MSG-E4` | Broker error paths — copy delta |
| A26 | `/help` | Beginner sentences + advanced pointer to README command table | Broker `/help` — copy delta |
| A27 | No auto-connect anywhere | Fresh Pi always `DISCONNECTED` after setup/restart | Extension inert-by-default invariant (existing) — regression-guard only |
