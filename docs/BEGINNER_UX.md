# Beginner UX Contract — Pi ⇄ Telegram on Windows 11 (T01, revised through T5B2)

Audience: non-technical users first, implementers second. This document is a **two-tier contract**: it separates what a beginner sees today from what is still a design target. Every string in quotes is either exact user-facing copy that exists in the code today (**implemented**) or an agreed target that no code prints yet (**design**). A reader must never have to guess which one they are looking at: every `MSG-…` id carries its status inline, and §0 is the per-id status table. It is documentation only — it adds no runtime behavior by itself. Section 13 maps each UX requirement to the existing safe operations it must be built on.

Conventions:

- `MSG-…` ids are stable copy references used by the acceptance matrix (§14) and the tests. **Implemented** ids are pinned by tests — the Telegram-side strings and copy builders by `tests/beginner-copy.test.mjs`, and the broker-side behavior that renders them by `tests/selective-tui.test.mjs`; **design** ids are not in any code path, and no test may assert them as live.
- Where live beginner copy differs from a design string, the live wording lives in `scripts/setup.ps1` (its `-Beginner` branches) and `Setup Pi Telegram.cmd`. Until a design id is implemented, those surfaces — not this document — are what the user actually reads.
- "Beginner path" means: no Windows internals (encryption, services, tasks, permissions), no short session ids, and no slash command is ever *required* beyond `/tg` — the phone stays button-driven. The only other commands a beginner ever meets are `/projects` (also the **Projects** button, §6.1), `/alias` (§5) and `/help` (§11); everything else stays in the advanced layer.
- V1 copy language: **English**. The friendly-label → operation mapping (§8) is written so a translation layer can replace strings later without changing behavior.

---

## 0. Copy status table (implemented vs. design)

Status was verified by reading the code, id by id — not estimated. **Implemented** means the exact quoted string exists on the named source location today. **Design** means the id's string exists nowhere in the code; the named surface is where it must be built, and that surface currently shows different (live) wording. **Superseded** means the id is retired: its string may still exist in the copy module (often still pinned by unit tests as an inert mapping), but no broker or extension code path emits it anymore — the surface it described was replaced. A superseded id is kept in this table for history only; no test may assert it as live copy, and new surfaces must not wire it back in.

| Id | Status | Source location (implemented) / build surface (design) |
|---|---|---|
| `MSG-S1`…`MSG-S11` | design | `scripts/setup.ps1` `-Beginner` branches + `Setup Pi Telegram.cmd` (live wording differs from every target string below) |
| `MSG-S12` | implemented | `scripts/setup.ps1` — Beginner component plan (missing-Pi warning) |
| `MSG-C1`…`MSG-C8` (incl. `MSG-C2B`, `MSG-C3B`) | implemented | `extension/selective-tui-extension.ts` (`MSG_C1_CONFIRM` … `MSG_C8_SETUP`) |
| `MSG-T2` | implemented | `src/beginner-copy.mjs` (`homeNoLive`), sent by `src/selective-telegram-broker.mjs` |
| `MSG-T3` | implemented | `src/beginner-copy.mjs` (`homeOne`) |
| `MSG-T4` | superseded | `src/beginner-copy.mjs` (`homeMultiple`) — the string still exists, but the broker no longer sends it: the multi-session home is now the Projects dashboard (§6.1) |
| `MSG-T5` | implemented | `src/beginner-copy.mjs` (`sessionGone`) |
| `MSG-T1` | design | broker `/start` home (setup-incomplete case) |
| `MSG-P1` | implemented | `src/beginner-copy.mjs` (`pendingSaved`) |
| `MSG-P2` | implemented | `src/beginner-copy.mjs` (`pendingSent`) |
| `MSG-P3` | design | broker no-session path (a live variant exists: `plainNoLive` / `noLiveGuidance`, wording differs) |
| `MSG-B1` | implemented | `src/beginner-copy.mjs` (`busyFollowup`) |
| `MSG-B2` | implemented | `src/beginner-copy.mjs` (`busySteer`) |
| `MSG-B3` | implemented | `src/beginner-copy.mjs` (`busyAbortSent`) |
| `MSG-B4` | design | busy-choice discard ack (a live near-variant exists: `busyDiscard`, wording differs) |
| `MSG-B5` | design | busy-choice card headline (live variant: `busyCard`, wording differs) |
| `MSG-B6` | design | busy-choice text prompt |
| `MSG-O1` | implemented | `src/beginner-copy.mjs` (`disconnectAsk` + `DISCONNECT_BUTTON`/`CANCEL_BUTTON`) |
| `MSG-O2` | superseded | `src/beginner-copy.mjs` (`stopAck`) — the string survives as an inert `cbAck('stop')` mapping pinned by unit tests, but no broker or extension path ever passes `'stop'`, so no live surface sends it (the `Stop the task` button confirms with `MSG-O3` instead) |
| `MSG-O3` | implemented | `src/beginner-copy.mjs` (`busyAborting`) — the live acknowledgement of the `Stop the task` button (§9): the session's identity header + " — Stopping the current task..." |
| `MSG-E1` | design | `scripts/setup.ps1` recoverable-failure paths |
| `MSG-E2` | design | broker error path (PC unreachable) |
| `MSG-E3` | design | setup repeated-failure path |
| `MSG-E4` | implemented | `src/beginner-copy.mjs` (`unknownCommand`) |
| `MSG-E5` | implemented | `scripts/setup.ps1` — unsafe-location gate (OneDrive refusal) |
| `MSG-E6` | implemented | `scripts/setup.ps1` — unsafe-location gate (protected-folder refusal) |

Project library, identity headers and aliases (T3/T4A/T4B2/T4C — implemented):

| Id | Status | Source location (implemented) |
|---|---|---|
| `MSG-D1` | implemented | `src/beginner-copy.mjs` (`projectsTitle`: "Your Pi projects"), rendered by `src/selective-telegram-broker.mjs` |
| `MSG-D2` | implemented | `src/beginner-copy.mjs` (`PROJECT_SECTION_ACTIVE`: "Active now", `PROJECT_SECTION_RECENT`: "Recent") |
| `MSG-D3` | implemented | `src/beginner-copy.mjs` (`projectRowLabel` row grammar, `projectColor` palette, `liveStateMarker`/`liveStateText` state circle and word) |
| `MSG-D4` | implemented | `src/selective-telegram-broker.mjs` (`Refresh` action row on the dashboard) |
| `MSG-D5` | implemented | `src/beginner-copy.mjs` (`staleCallbackToast`): "That button is out of date. Open Projects and try again." — callback feedback only, never a chat message |
| `MSG-H1` | implemented | `src/beginner-copy.mjs` (`identityHeader`) — every finalized answer and every session-targeted acknowledgement (§5); global/help/dashboard/cancel replies without session context stay unprefixed |
| `MSG-A1` | implemented | `src/selective-telegram-broker.mjs` (`USAGE.alias`) |
| `MSG-A2` | implemented | `src/beginner-copy.mjs` (`aliasNoSelection`) |
| `MSG-A3` | implemented | `src/beginner-copy.mjs` (`aliasInvalid`) |
| `MSG-A4` | implemented | `src/beginner-copy.mjs` (`aliasFailed`) |
| `MSG-A5` | implemented | `src/beginner-copy.mjs` (`aliasSaved`, `aliasCleared`) |

Remote ordinary choice cards (T4A — implemented):

| Id | Status | Source location (implemented) |
|---|---|---|
| `MSG-Q1` | implemented | `src/beginner-copy.mjs` (`choiceCard`): identity header, sanitized question, one numbered option row per option, and the fixed not-permission sentence |
| `MSG-Q2` | implemented | `src/beginner-copy.mjs` (`choiceOptionButton`): exactly one button per option, labeled `N. Label` |
| `MSG-Q3` | implemented | `src/beginner-copy.mjs` (`CHOICE_BUTTON_CANCEL`): the `Cancel this question` row |
| `MSG-Q4` | implemented | `src/beginner-copy.mjs` (`choicePendingPlain`): the fixed typed-text guard |
| `MSG-Q5` | implemented | `src/beginner-copy.mjs` (`staleChoiceToast`): the fixed stale/expired toast |
| `MSG-Q6` | implemented | `src/beginner-copy.mjs` (`choiceAnsweredToast`, `choiceCancelledToast`): fixed settle toasts for an accepted answer and an explicit cancel |

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
- Buttons always state the outcome ("Stop the task"), never the mechanism (`/abort`).
- Every error names the next action ("Press Enter to try again").
- Session names are **readable labels** (§5), e.g. `Pi · demo-project` — never `tg:xxx`.

---

## 3. Windows setup — state machine

Entry: the user double-clicks the setup launcher (a thin double-clickable wrapper that runs `scripts/setup.ps1`; the wrapper is an implementation delta, see §13). One window, one question at a time.

States: `NOT_ENROLLED → TOKEN_PROMPT → TOKEN_CHECK → QR_WAITING → (QR_EXPIRED ↺) → ENROLLED → SERVICE_RUNNING`; any step may enter `RECOVERABLE_FAILURE` and return to the failed step.

Status: **every string in this state machine except `MSG-S12` is design.** The live `-Beginner` setup copy in `scripts/setup.ps1` and `Setup Pi Telegram.cmd` differs from every target string below (§0); this table is the target those surfaces must converge on.

| State | Trigger | Exact copy / behavior |
|---|---|---|
| `NOT_ENROLLED` | Launcher opened, PC not linked yet | `MSG-S1` (design): "Welcome! This links your PC to your own Telegram bot so you can talk to Pi from your phone. Press Enter to start." |
| `NOT_ENROLLED` (already linked) | Launcher opened, PC already linked | `MSG-S2` (design): "This PC is already linked. Press Enter to keep the current link, or type RESET to start over." |
| `TOKEN_PROMPT` | User pressed Enter | `MSG-S3` (design): "Paste the token BotFather gave you (it looks like 123456789:AA…), then press Enter. It stays on this computer." Input masked; no echo. |
| `TOKEN_CHECK` | Token pasted | `MSG-S4` (design): "Checking your bot…". On success: `MSG-S5` (design): "Found your bot: @<botname>." |
| `TOKEN_CHECK` (invalid token) | Bot check fails | `MSG-S6` (design): "That token didn't work. Copy it again from BotFather (send /token to BotFather to see it) and paste it here." → stays in `TOKEN_PROMPT`. |
| `QR_WAITING` | Bot verified | `MSG-S7` (design): "Open the Camera app on your phone and point it at this code. Tap the Telegram link, then tap Start." QR rendered locally; below it: `MSG-S8` (design): "Waiting for your scan… (expires in 60 seconds)" with a live countdown. |
| `QR_EXPIRED` | 60 s elapsed without scan | `MSG-S9` (design): "The code expired. Press Enter for a new one." → fresh code, same `QR_WAITING` copy. Three consecutive expiries → `RECOVERABLE_FAILURE` with `MSG-E3`. |
| `ENROLLED` | Scan paired successfully | `MSG-S10` (design): "Done! Your PC and Telegram are linked." |
| `ENROLLED` (note, beginner path) | Setup finished but Pi is not on the PC yet | `MSG-S12` (implemented): "Pi is not on this computer yet. Your private link is safe and will wait." + "Install Pi on this PC, then open it and type /tg to connect." Warning only — setup still succeeds. |
| `SERVICE_RUNNING` | Background link started | `MSG-S11` (design): "Your link is active. Open Pi, type /tg, and send a message from your phone. The connection only runs while you keep it on — use the telegram switch to turn it on or off." |
| `RECOVERABLE_FAILURE` | Any recoverable error (scan failed, network down, restart needed) | `MSG-E1` (design): "Something didn't work: <plain reason>. Nothing was changed — your previous settings are intact. Press Enter to try again, or close this window." Plain reasons from a fixed whitelist (§10); internal causes never surface by name. |

Hard rules:

- Abort or failure at any point leaves any previous link intact (atomic commit only on success).
- Setup never asks for, prints, or logs the token again after `TOKEN_PROMPT`.
- `MSG-S11` is the only place setup mentions automatic startup; it is phrased as "your link", never "service"/"task".

---

## 4. Pi `/tg` — state machine

`/tg` is the beginner alias of the existing opt-in connect command. **Every Pi process stays disconnected by default; nothing ever connects automatically.** The extension is present but inert until the user types `/tg` in that specific Pi window. Status: **all copy in this state machine is implemented** in `extension/selective-tui-extension.ts` (§0).

States: `DISCONNECTED → CONFIRM_PROMPT → CONNECTED`; `CONNECTED → DISCONNECT_PROMPT → DISCONNECTED`. `BUSY` is an annotation that changes copy, not reachability.

| State | Trigger | Exact copy / behavior |
|---|---|---|
| `DISCONNECTED` | `/tg` typed, this Pi not linked | `MSG-C1` (implemented; confirmation prompt): "Link this Pi window to Telegram? You'll be able to send it messages from your phone and it will reply there. [Connect] [Cancel]" |
| `CONNECTED` | User chose Connect and the PC phone connection has a fresh matching heartbeat | `MSG-C2` (implemented): "Linked. Send a message from your phone — this Pi (Pi · <label>) will answer. Type /tg off to unlink." The label is auto-derived: project folder name (§5). |
| `CONNECTED_LOCAL_ONLY` | User chose Connect but the PC phone connection is missing, stale, shut down, foreign or dead | `MSG-C2B` (implemented): "Linked, but the phone connection on this PC isn't running right now. In the Pi Telegram folder run ".\telegram on", then send your message again. This Pi will stay linked." The local link remains active so routing recovers automatically when the PC connection returns. |
| `CONNECTED` | `/tg` typed while linked and the PC phone connection is live | `MSG-C3` (implemented): "This Pi is linked as 'Pi · <label>' (currently <state>). Type /tg off to unlink." (idempotent status, no re-confirmation) |
| `CONNECTED_LOCAL_ONLY` | `/tg` typed while linked but the PC phone connection is unavailable | `MSG-C3B` (implemented): "This Pi is linked as 'Pi · <label>', but the phone connection on this PC isn't running right now. Run ".\telegram on" in the Pi Telegram folder, then try again." |
| `BUSY` (annotation on connect) | `/tg` confirm while a task is running | Confirm copy appended: `MSG-C4` (implemented): "Note: this Pi is in the middle of a task. Its result will arrive on Telegram when it finishes." |
| `DISCONNECT_PROMPT` | `/tg off` typed while linked | `MSG-C5` (implemented): "Unlink this Pi from Telegram? [Unlink] [Cancel]" |
| `DISCONNECTED` (after unlink) | User chose Unlink | `MSG-C6` (implemented): "Unlinked. This window no longer talks to Telegram." |
| `DISCONNECT_PROMPT` (busy) | `/tg off` while a task is running | Copy appended: `MSG-C7` (implemented): "Warning: a task is still running here. Its result will NOT be sent to Telegram anymore. [Unlink anyway] [Cancel]" |
| (any) | `/tg` in a Pi with setup incomplete | `MSG-C8` (implemented): "Your PC isn't linked to Telegram yet. Double-click Setup Pi Telegram on your PC first, then come back here." |

Hard rules:

- No automatic connection, ever: a fresh Pi process is always `DISCONNECTED`, even after setup and even if other Pi windows are linked.
- Confirmation is required for connect **and** disconnect; busy variants of both exist.
- `/tg` and `/tg off` must also appear in Pi's command help; the long names (`/telegram-connect`, `/telegram-disconnect`, `/telegram-status`) remain valid and are documented as advanced (§11).

---

## 5. Readable labels, identity headers and aliases (applies everywhere)

- Auto-derived label = project folder name the Pi window is working in: `Pi · demo-project`, `Pi · notes-app`.
- Collisions between simultaneously linked windows get an ordinal suffix in link order: `Pi · demo-project (2)`. The suffix is cosmetic and stable for the life of the link.
- Labels are what appear in every Telegram button and message. Short ids (`tg:xxx`) exist internally for addressing but **never appear in beginner copy** (they remain visible in advanced commands, §11).

### Identity header (T4B2 — implemented)

Every finalized Pi answer and every broker acknowledgement that names a retained concrete session target is prefixed with the window's identity header (`MSG-H1`). Replies without session context — the global `/help` text, the Projects dashboard, and the cancel notice — stay unprefixed. The prefixed form is:

```
<color square> Pi · <name>[ · <branch>]
```

- Name precedence: the session alias, then the project alias, then the auto-derived label — the first candidate that survives sanitization wins.
- The header is pure identity: never a state or liveness word, and never cwd, pid, short or tracking ids, tokens, raw errors, or a model name.
- The whole header is clipped to 64 Unicode code points without splitting a surrogate pair; the branch appears only when its entire sanitized form fits the budget — otherwise it is omitted, never half-shown.
- Bad or missing metadata degrades to the neutral `⬜ Pi`. The same `⬜` is also a normal palette color (slot 7, §6.1), so it can appear on a perfectly healthy row or header — it is orientation, never an error badge.

### `/alias` — name one window (T4C2 — implemented)

`/alias` names an individual Pi window, not a project, so several windows working in the same project stay distinguishable:

| Input | Behavior |
|---|---|
| `/alias` | Usage only, mutates nothing: `MSG-A1` (implemented): "Usage: /alias <name> — rename the selected Pi. /alias clear — reset it. /alias <shortId> <name\|clear> — rename a specific window." |
| `/alias <name>` | Renames the SELECTED live session only — never a guess, never a sole-session auto-select. On success: `MSG-A5` (implemented): "Alias saved." immediately followed by the freshly re-rendered Projects dashboard (§6.1). |
| `/alias clear` | Clears the selected live session's alias: `MSG-A5`: "Alias cleared." + dashboard. |
| `/alias <shortId> <name\|clear>` | Advanced form: targets that exact unique live session and leaves the current selection untouched. The first token is read as a short id ONLY while it uniquely resolves against the live sessions; otherwise the whole argument is the alias (so names like `home pc` never misparse). |

Failure copies are fixed and never echo the rejected input: no live selection → `MSG-A2` (implemented): "No Pi window is selected. Send /projects, pick one, then try /alias <name> again."; invalid input → `MSG-A3` (implemented): "That name can't be used. Use up to 64 normal characters and try again."; store refusal or throw → `MSG-A4` (implemented): "The alias could not be saved right now. Try again in a moment." Input is normalized (trim + whitespace collapse) and refused BEFORE the store when it is empty, longer than 64 UTF-16 chars, starts with `/` or still carries control characters.

Persistence (honest limits): an alias is keyed to the session's tracking id. It survives broker restarts, same-tracking connection takeover and disconnect/re-register (retained for 30 days). It does NOT survive a full Pi process restart — a new window is a new tracking id and starts with its default label again — and it never carries across a project identity change. A project-level alias also exists in the store and acts as a header fallback, but no Telegram command sets it today (store/advanced API only).

---

## 6. Telegram `/start` home

What the user sees when they open the bot chat or send `/start` (also shown automatically the first time after pairing). Status: **all copy in this table is implemented** in `src/beginner-copy.mjs` (§0) except `MSG-T1` (design) and `MSG-T4` (superseded by §6.1).

| Situation | Exact copy / behavior |
|---|---|
| Setup not finished | `MSG-T1` (design): "Hi! Your PC needs one more step: double-click Setup Pi Telegram on your PC, then come back here." |
| Linked, no live Pi | `MSG-T2` (implemented): "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg." |
| Exactly one live Pi | `MSG-T3` (implemented): "Connected to Pi · <label>. Just type a message and it goes to that Pi." — no buttons needed; the session is auto-selected. The name inside the sentence is the full identity header (§5), and the reply carries the session action row: `[Status]`, `[Stop the task]` while busy, `[Projects]`, `[Disconnect]` (only Stop and Disconnect are danger-styled). |
| Multiple live Pis | The Projects dashboard (§6.1), titled `MSG-D1` (implemented): "Your Pi projects" — one `Active now` row per live session, a `Recent` section for 30-day project history, and `Refresh`. The old `MSG-T4` chooser ("Which Pi should I talk to?" + label buttons) is superseded and no longer sent. No short ids anywhere. |
| Selected session disappeared | `MSG-T5` (implemented): "Pi · <label> just closed or disconnected. Pick another:" followed by the fresh Projects dashboard (§6.1) — the `Active now` rows and `Refresh`, exactly the dashboard's own buttons — or `MSG-T2` when no session is left to pick. Nothing the user typed is lost silently: a held prompt follows the rules in §7. |

Auto-selection rule: with exactly one live session, it is selected implicitly and `MSG-T3` says so. With multiple, **nothing is auto-selected** — plain text is held (§7) until the user picks.

### 6.1 The Projects dashboard (T3/T5A — implemented)

With more than one live session — and from the **Projects** button or the `/projects` command at any time — the bot answers with the mobile Projects dashboard instead of the old chooser. The **Projects** button is the beginner path; `/projects` itself is listed in the advanced help (§11). Selection is preserved. Opening or refreshing the dashboard only displays state and enqueues nothing; the only actions a dashboard row can trigger are a target change (selecting an active row) and, when that row carries a held prompt's generation (§7), the exactly-once dispatch of that pending prompt.

Card anatomy (all implemented):

- Title: `MSG-D1` (implemented): "Your Pi projects" — or `MSG-P1` ("Your message is saved. Choose which Pi should get it:") while a held prompt waits, or `MSG-T2` when nothing is live or recent.
- `MSG-D2` (implemented) section headers rendered as disabled, untappable rows: **Active now** — one row per live session (at most 32 listed); **Recent** — one row per project history entry from the last 30 days (newest first, at most 20) that has no live window right now.
- `MSG-D3` (implemented) row grammar: `[✓ ]<state circle> <color square> <name>[ (<branch>)] · <state word>` — `🟢 Available`, `🟡 Working`, `🟡 Waiting`, `⚪ Offline`; recent rows always render `⚪ Offline`.
- `MSG-D4` (implemented): **Refresh** re-renders the dashboard.

Style and safety rules:

- Selected live row → `✓` prefix + Telegram primary (blue) style; live connected rows → success (green) style; busy/waiting rows → default style; only destructive controls (Disconnect, Stop) ever carry the danger style.
- Color is never the only signal: every row carries both a state circle and a state word.
- The palette has eight squares (🟦 🟪 🟧 🟩 🟨 🟫 ⬛ ⬜). `⬜` is both palette slot 7 and the neutral fallback for a missing or malformed color slot, so it can appear as a perfectly valid project color — it is orientation, never an error badge.
- Recent rows are native disabled buttons with no callback: they cannot be tapped and never route.
- Tapping an active row selects it; while a pending prompt is held, the same row dispatches that prompt exactly once (§7).
- Tapping the row that is already selected is safe and idempotent: the target is re-validated and every tap is answered, but only an actual selection change re-renders the dashboard — repeated same-target taps never queue a duplicate dashboard and never re-route.
- Names shown are the alias-first identity candidates (§5); short ids stay inside callback_data and never appear in visible text (§10).
- A history read failure degrades to the live-only view instead of throwing.

Selection persistence (T4A — implemented): the selection is durable in the store as an exact (tracking id, project key) pair. When the broker restarts, it adopts that selection ONLY when exactly one current live session matches BOTH values; a stale row, a missing row, a project mismatch, a malformed persisted target or an ambiguous match is cleared (durably and in memory) and never routed. A live selection that goes stale mid-session is cleared the same way. A closed or offline project is therefore never routed to silently.

Explicit non-goals for the dashboard: no groups, no topics, no cloud sync, no multi-user surface — it exists only inside the single enrolled private owner chat.

---

## 7. Plain text routing

An ordinary text message (not starting with `/`) from the authorized user.

| Situation | Behavior / copy |
|---|---|
| One live Pi (auto-selected) | Direct dispatch. No prompt, no buttons. |
| Multiple live Pis, none selected | **Hold exactly one pending prompt.** Reply `MSG-P1` (implemented): "Your message is saved. Choose which Pi should get it:" as the title of the Projects dashboard (§6.1), whose active rows carry the held prompt's generation. Tapping an active row dispatches the held text **once** to that Pi, then confirms `MSG-P2` (implemented): "Sent to <identity header>." — the identity header itself is embedded inside the sentence; the reply is that one line, not a header line with the sentence rendered under it (§5). |
| Second plain text while one is pending | The new text **replaces** the pending one (the older text is discarded, never dispatched). The dashboard re-renders under `MSG-P1` with the new text waiting. This keeps the invariant "at most one pending prompt, dispatched at most once". |
| No live Pi | `MSG-P3` (design): "There's no Pi connected right now. Open Pi on your PC and type /tg — then your messages will reach it. (Nothing was lost — send it again once Pi is linked.)" A live variant already runs (`plainNoLive` in `src/beginner-copy.mjs`); its wording differs from this target. |
| Selected Pi is busy | Busy choice card (§8) — the text is held as the pending prompt until the user picks. |
| Session vanished between hold and choice | Tapping a dead session's row → `MSG-T5` (§6) under its last-known identity header, followed by the fresh dashboard; the pending prompt stays pending for the next choice. |

Hard rules:

- Exactly-once: a pending prompt is dispatched exactly once, deduplicated across retries and duplicate callback presses. The first tap of a current-generation row dispatches the held text **once** and confirms `MSG-P2`; any later tap of that row — after the generation was consumed or replaced — dispatches nothing and sends **no chat message and no replacement dashboard** (§6.1). Instead the tap itself is answered with `MSG-D5` as `answerCallbackQuery` text so the spinner stops. It never re-sends `MSG-P2`, and it is not a silent no-op: the toast is the answer.
- The pending prompt's text is **never** echoed into button payloads (§10) and never dispatched to a session the user did not pick.

---

## 8. Busy choices

When the selected Pi is mid-task and the user sends plain text, the message is held behind a fresh generation and the bot answers with the busy choice card: `MSG-B5`'s headline remains a design target — the implemented live headline is "<header> is still working on the current task. What should I do with your message?" — above the four readable buttons below, each on its own row. The table is the explicit implementer mapping; the left column is what the user sees (all four button labels are implemented), the right column the existing safe operation it maps to. The words *steer*, *follow-up* and *abort* are **not** shown to beginners.

| Button (user-facing, V1 English) | Maps to | Effect copy after tap |
|---|---|---|
| `Add my message for after this task` (implemented) | follow-up (queue for running turn) | `MSG-B1` (implemented): "Got it — Pi · <label> will see your message right after the current task." |
| `Redirect the current task` (implemented) | steer (inject into running turn) | `MSG-B2` (implemented): "Done — Pi · <label> got your message and will adjust what it's doing." |
| `Stop the task and use my message` (implemented) | abort, then dispatch held prompt to the idle session | `MSG-B3` (implemented): "Stopped. Your message is on its way to Pi · <label>." |
| `Leave it alone` (implemented) | no-op (cancel; held prompt discarded if one existed, else nothing) | `MSG-B4` (design): "Okay — I left Pi · <label> working." (a live near-variant exists: `busyDiscard`, wording differs) |

If there is no held prompt (user tapped busy actions without sending text), the card is: `MSG-B5` (design): "Pi · <label> is working on a task. What would you like to do?" + the four buttons above (the first three then prompt for text with `MSG-B6` (design): "Type your message and send it."). A live variant of the card headline runs (`busyCard` in `src/beginner-copy.mjs`); its wording differs from this target.

Hard rules:

- Mapping is data, not prose: implementers bind each label to exactly one existing bridge operation; no new execution path is introduced.
- After any choice the card resolves; stale duplicate taps are no-ops (§10).

---

## 8A. Pi-initiated question cards (remote ordinary choices — implemented)

Section 8 covers what the *user* initiates while Pi is busy. This section is physically distinct: it covers the card Pi itself raises when it needs an ordinary decision to continue the current task. The two flows never mix — a busy choice routes a held prompt, while a Pi-initiated question answers Pi's own tool call (`telegram_ask_user_choice`) with 2–4 ordered options.

When the linked Pi calls `telegram_ask_user_choice`, the bot renders one card in the enrolled private chat (all copy below is implemented, §0):

- `MSG-Q1`: the window's identity header (§5), then the sanitized question (at most 500 characters), then one numbered row per option — `1. Label — Description` — and finally the fixed sentence, verbatim:

  > This is an ordinary workflow choice for the current task — not a permission, approval or security prompt.

- `MSG-Q2`: exactly one button per option row, labeled `N. Label`. There is never a second button for the same option and never a button that is not an option.
- `MSG-Q3`: one separate `Cancel this question` row. Cancel is explicit and chooses nothing.
- `MSG-Q4`: while a question is pending, plain text is refused with the fixed typed-text guard: "Pi asked you a question above. Use the buttons on that question to answer it — typing here is not
  an answer." The guard text is fixed and never echoes the typed text.
- One pending question per Pi window and a fixed 30-minute deadline: a second request while one is pending fails closed instead of replacing the first.
- `MSG-Q5`: tapping an expired, stale, replayed or post-restart button never chooses anything; the tap is answered with the fixed stale toast: "That question is out of date. Pi will ask again if it still needs an answer."
- `MSG-Q6`: an accepted tap settles silently with the toast "Answer received. Pi is continuing with your choice."; an explicit cancel settles with "Okay — the question was cancelled. Nothing was chosen." Neither settlement sends a chat message.
- The card exists only in the enrolled private chat between the owner and the bot (§12); every callback is revalidated against the enrolled user and chat ids.
- Callback data stays opaque and bounded: an answer is `v1:w:<16 hex>:<0-3>` (opaque request id plus zero-based option index) and a cancel is `v1:W:<16 hex>`. No labels, option values, question text or ids ever appear in visible copy — the card shows only the header, the question and the option labels/descriptions.

What this card is NOT: it is never a permission, approval or security prompt, and it is never a general remote-control channel. Provider-owned consent, Gentle AI review consent, permission/security/maintenance gates, project trust, secrets and native editor UI stay on the PC — the bridge never answers them and Telegram never sees them.

---

## 9. Final output card

Every finalized Pi answer arrives as one message under the window's identity header (§5), followed by an action row. There is no streaming, no partial text, no hidden content.

Card shape (Telegram, implemented):

```
<identity header>

<final answer text>

[Projects]  [Disconnect]
```

| Button | Behavior |
|---|---|
| *(typing any text)* | "Reply" is implicit: a new plain text follows §7 routing to the same selected Pi. There is no Reply button to press. |
| `Projects` | Opens the Projects dashboard (§6.1) — the replacement for the retired **Change Pi** chooser. |
| `Disconnect` | `MSG-C5` equivalent, remotely: `MSG-O1` (implemented): "Unlink Pi · <label>? You can relink it any time from the PC. [Unlink] [Cancel]" Disconnect is destructive and carries the danger style. |

The final-output keyboard offers ONLY `Projects` and `Disconnect` — never `Stop` after a final output — and only while the originating session is still live. A `Stop the task` button (danger style) appears on busy session action rows and status cards, including the interim card that reports a still-running task (where Stop is the only button). It maps to abort and confirms with `MSG-O3` (implemented): "<identity header> — Stopping the current task..." — the task has been told to stop; the line does not claim the session is already idle. That Stop button is a distinct control from §8's busy choice `Stop the task and use my message`: plain Stop only aborts the current task and confirms `MSG-O3`, while the §8 choice aborts and then dispatches the held prompt to the now-idle session. The retired `MSG-O2` line ("Stopped. Pi · <label> is idle now.") is superseded: no live code path sends it (§0).

Retired design text: the old `[Change Pi]` button and the "Reply by just typing here · /help for more" footer are not implemented and no code prints them; the header line plus `[Projects]` `[Disconnect]` above is the whole card.

Delivery rules unchanged: bounded message size, safe chunking (the header appears exactly once, the keyboard rides on the final chunk), final text only — no reasoning, no tool transcripts, no token stream.

---

## 10. Callback payload and authorization constraints

All beginner buttons are Telegram inline callbacks. Constraints, verifiable per callback:

1. **Bounded opaque ids only.** `callback_data` carries at most: an operation tag, a bounded opaque session reference (opaque token mapped server-side to the real short id; ≤ 32 chars), and, for the pending-prompt choice, a bounded opaque pending-prompt id (≤ 32 chars). No prompt text, no labels, no secrets, no tokens inside callbacks.
2. **Exact authorization.** Every callback and message is accepted only from the exact enrolled private chat id **and** enrolled user id (both must match); anything else is ignored silently.
3. **Idempotent / deduped.** Telegram `callback_id`s are answered exactly once; session-choice and pending-dispatch callbacks dedupe so a double-tap cannot dispatch twice or dispatch to two sessions. Command execution keeps the existing exactly-once claim discipline.
4. **No secrets or prompt text in transit metadata.** The held prompt text lives server-side only, keyed by the pending id; callbacks never contain it. The bot token never appears in any chat, log, callback or payload.
5. **Fail-closed.** A malformed or oversized callback (including an unknown operation tag) is consumed silently: it is answered and logged, and it never dispatches anything. A dead, stale or ambiguous selection resolves with the friendly stale copy — the named Pi, when the bridge knew it, is reported as just closed or disconnected (`MSG-T5`) — followed by the fresh Projects dashboard (§6.1), or the no-live guidance (`MSG-P3`-family copy) when nothing is left. An expired or consumed pending-prompt generation dispatches nothing and sends no chat message or replacement dashboard: the tap is answered with `MSG-D5` (§7). None of these paths ever answers with a guess, an error trace, or jargon.

---

## 11. Errors and the advanced escape hatch

Friendly errors follow the fixed-whitelist pattern: each known failure has one plain-English line plus a next action. Status per id: `MSG-E4` implemented (`src/beginner-copy.mjs`); `MSG-E2` and `MSG-E3` design; `MSG-E5` and `MSG-E6` implemented (`scripts/setup.ps1` unsafe-location gate).

| Situation | Copy |
|---|---|
| PC unreachable (asleep/offline) | `MSG-E2` (design): "Pi isn't answering right now — is your PC awake? It can't reply while asleep or offline. Try again in a moment." |
| Repeated setup failure | `MSG-E3` (design): "Setup keeps failing. Check your internet connection and try again. If it still fails, the 'Fix problems' section of the guide on your PC has next steps." |
| Unknown `/`-command typed by a beginner | `MSG-E4` (implemented): "I didn't understand that. Send /help to see what I can do." (Lines starting with `/` inside a prompt remain refused, as today.) |
| Setup run from inside OneDrive (or any synced folder) | `MSG-E5` (implemented): "This folder is inside OneDrive, so your private link cannot stay only on this PC." + "Move the setup folder to a normal folder on this PC (for example C:\pi-telegram-bridge), then run setup again." Setup refuses before anything is written or asked for: the credential blob must stay on this PC, and a synced folder copies it elsewhere no matter what local permissions say. |
| Setup run from a protected Windows folder (for example Program Files) | `MSG-E6` (implemented): "This folder is inside a protected Windows folder, so setup cannot keep your private link safe here." + the same next action as `MSG-E5`. Setup refuses before anything is written or asked for. |
| Text sent to a dead session | `MSG-T5` (§6). |

**Advanced escape hatch.** `/help` always answers with a two-part reply: the three beginner sentences (talk to Pi by typing; type /tg on the PC to link; this chat is private to you), then a labeled `Advanced commands:` block that lists the commands itself — `/projects` (show your projects and pick one), `/alias <name>` (rename the selected Pi window; `/alias clear` resets it), `/sessions`, `/use`, `/status`, `/send`, `/steer`, `/followup`, `/abort`, `/disconnect`. All existing slash commands keep working unchanged for users who opt in; the full command documentation is the **Advanced Telegram commands** table in `docs/ADVANCED.md` — never the beginner path — and short ids appear only in that advanced layer.

---

## 12. Explicit non-goals (V1)

- **No generic command/shell surface.** No remote terminal, no CMD/PowerShell endpoint, no arbitrary command execution — remote input reaches Pi only through its official message/steer/follow-up/abort APIs.
- **No hidden reasoning or tool stream.** Final outputs only; no thinking content, no token-by-token streaming, no tool-call transcripts.
- **No auto-connect.** Setup links the PC; it never links a Pi process. Every Pi window connects only when the user types `/tg` in it, every time.
- **No public listener.** Outbound polling to Telegram only; nothing listens on the network, ever.
- **No multiplatform setup in V1.** Windows 11 only; no macOS/Linux setup flow, no cloud relay.
- **No beginner-visible ids or jargon.** Short ids, service/task/ACL/DPAPI wording stay in advanced documentation only.
- **No groups, topics, or cloud sync.** The bridge serves exactly one enrolled private owner chat on one PC; there is no group-chat surface, no topic/thread model, and nothing is mirrored to or from the cloud.

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

Status of these gaps: items 1–6 are implemented — the double-clickable Windows wrapper (`Setup Pi Telegram.cmd`) on the setup side, and, on the Telegram side, the `/tg` alias with confirmation prompts and busy annotations, alias-aware readable labels, inline keyboards with opaque bounded callbacks (including the Projects dashboard, §6.1), the single-pending-prompt hold-and-choose flow, and centralized Telegram-side copy (`src/beginner-copy.mjs`, pinned by `tests/beginner-copy.test.mjs`). The setup-side copy (§3) is still per-surface in `scripts/setup.ps1` and `Setup Pi Telegram.cmd`, and every **design** id in §0 remains open.

Nothing in this contract weakens existing guarantees: no secrets in chat/argv/logs, no shell endpoint, no listener, no auto-connect, final outputs only.

---

## 14. Acceptance matrix

Each row: observable state/event → required visible copy/action → the implementation surface that must satisfy it. Copy status per id is defined in §0: an **implemented** id's string already runs on the named surface (pinned by tests); a **design** id is the agreed target that must still be built there. As of the T5A revision, status is per copy id (§0) and per implementation surface, never per row alone: a row whose surface is implemented can still carry **design** copy that is unbuilt (A19 carries design `MSG-P3`; A20 carries design `MSG-B4`, `MSG-B5` and `MSG-B6`; A25 carries design `MSG-E2` and `MSG-E3`). The broker- and extension-side surfaces of rows A7–A10 and A12–A27 are implemented, and the "Delta" notes in their surface columns describe what had to be built and are kept for history. The remaining open surfaces are setup-side (A1–A6); A11 is broker-side design copy (`MSG-T1`, §0), not a setup surface. Per-id status language is unchanged: every **design** id in a Copy cell (§0) is still unbuilt.

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
| A14 | `/start`, multiple live sessions | Projects dashboard (§6.1): `MSG-D1`–`MSG-D4` rows (no short ids) | Broker multi-session home — implemented (`#projectsReply`) |
| A15 | Selected session disappeared | `MSG-T5` + repick buttons | Broker stale-selection handling (exists) — copy + keyboard delta |
| A16 | Plain text, one session | Direct dispatch, no copy | Existing plain-text routing |
| A17 | Plain text, multiple unselected | Hold one pending prompt; `MSG-P1`; dispatch once on choice; `MSG-P2` | Delta: pending-prompt hold keyed by opaque id; exactly-once dispatch |
| A18 | Second text while pending | Replace pending, re-show `MSG-P1` | Delta: pending replacement rule |
| A19 | Plain text, no session | `MSG-P3` | Existing no-session fail-closed path — copy delta |
| A20 | Text/act on busy session | §8 card + four buttons mapped to follow-up/steer/abort+send/cancel | Existing `/followup`/`/steer`/`/abort` ops — delta: busy detection + keyboard |
| A21 | Final output arrives | Card per §9: identity header + text + `[Projects]` `[Disconnect]` | Implemented bounded final-output delivery with `#finalOutputKeyboard` |
| A22 | `Stop the task` on busy session action rows/status cards (the interim busy status card carries Stop as its only button) | `MSG-O3` via abort (`MSG-O2` superseded, no caller) | Existing `/abort` op — implemented (`v1:x` callback binding, §10) |
| A23 | Any callback | §10 constraints 1–5 (opaque bounded ids, dual-id authorization, dedupe, no prompt text, fail-closed) | Broker callback handling + existing dual authorization + dedup store — delta: callback ops |
| A24 | Unauthorized sender/chat | Silent ignore | Existing exact user+chat authorization (unchanged) |
| A25 | Friendly errors | `MSG-E2`, `MSG-E3`, `MSG-E4` | Broker error paths — copy delta |
| A26 | `/help` | Beginner sentences + `Advanced commands:` block listing `/projects` and `/alias` (full table: `docs/ADVANCED.md`) | Broker `/help` — copy delta |
| A27 | No auto-connect anywhere | Fresh Pi always `DISCONNECTED` after setup/restart | Extension inert-by-default invariant (existing) — regression-guard only |
| A28 | Projects button or `/projects` tapped | Dashboard per §6.1: `MSG-D1` title, `MSG-D2` sections, `MSG-D3` rows, `MSG-D4` Refresh | `#projectsReply` / `#planProjects` — implemented |
| A29 | Dashboard row states | `🟢 Available` / `🟡 Working` / `🟡 Waiting` / `⚪ Offline` plus the stable per-project color square | `projectRowLabel` / `liveStateMarker` / `liveStateText` — implemented |
| A30 | Selected live row | `✓` prefix + primary (blue) style | `#liveRowButton` — implemented |
| A31 | Recent row (30 days, at most 20) | Disabled inert row rendering `⚪ Offline`; never routes | `#projectsReply` disabled buttons — implemented |
| A32 | Broker restart with a durable selection | Adopted only when exactly one live session matches BOTH tracking id and project key; otherwise cleared, never routed | `#adoptDurableSelection` + store selected-target — implemented |
| A33 | Any finalized answer or acknowledgement naming a retained concrete session target | Identity header `MSG-H1` (§5): color square, alias → project alias → label name, branch when it fits — global/help/dashboard/cancel replies without session context stay unprefixed | `identityHeader` via `#sessionHeader`/`#eventHeader` — implemented |
| A34 | `/alias <name>` or `/alias clear` on a selected session | `MSG-A5` ack + immediate dashboard re-render | `#planAlias` — implemented |
| A35 | `/alias <name>` or `/alias clear` with no selected live session | `MSG-A2`, nothing mutated (bare `/alias` stays usage-only `MSG-A1`, §5) | `#planAlias` — implemented |
| A36 | Invalid alias input | `MSG-A3`, no echo of the rejected input | `#planAlias` — implemented |
| A37 | Store refuses the alias save | `MSG-A4`, one fixed log code, no TUI command enqueued | `#planAlias` — implemented |
| A38 | Alias persistence | Survives broker restart and same-tracking reconnect (30-day retention); does not survive a new Pi process (new tracking id) | `store.setTuiSessionAlias` — implemented |
| A39 | Linked Pi calls `telegram_ask_user_choice` | Card per §8A: `MSG-Q1`–`MSG-Q3` rows plus Cancel; one pending per window, 30-minute deadline | Broker `choice_request` render — implemented |
| A40 | Owner taps an option or Cancel | Exactly one `choice_response` command for that exact window; `MSG-Q6` toast; silent settlement, no chat message | Broker `v1:w`/`v1:W` callback handling — implemented |
| A41 | Stale, expired, replayed or post-restart tap | `MSG-Q5` stale toast, nothing chosen, row dropped | Broker callback validation — implemented |
