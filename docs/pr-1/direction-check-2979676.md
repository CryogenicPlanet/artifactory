# Direction check at 2979676

Light single-agent scan of the twelve commits Codex pushed after the first delta pass (181939b..2979676), before it finishes the checklist. Not a full review.

## Per decision

| Item | Verdict | Evidence |
| --- | --- | --- |
| 1 read marks | matches | marks advance on view, `mark=0` peeks, no `POST /api/read` (`server/src/conversation.ts:100`) |
| 2 top-level ext routes | matches | `reserved()` at `kernel/ext.ts:429`; duplicate fails alone naming the route (`:235`); overrides logged (`:258`) |
| 3 reactions | matches | gone from routes, services, UI; old tables dropped by a rung (`kernel/idempotency.ts:276`) |
| 4 no inbox/digest/budget | letter met, one gap | routes gone; `mentions`, `exclude_self`, `newest` real (`conversation.ts:20`); no `examples/extensions/` directory at this head, the digest was deleted rather than relocated |
| 5 `.handle()` | matches, one soft spot | zero `handleRaw`; payloads decode through declared schemas with `onExcessProperty: "error"`; but `limit`, `wait`, `since` are declared as strings and hand-parsed (`conversation.ts:69`) |
| 6 typed errors | matches | one literal-keyed record (`conversation-request.ts:15`); unknown causes become `handler_failed` (`:261`), never retriable |
| 7 extension power | weakest: the name is ahead of the thing | the five verbs exist and subscriptions uses them (`kernel/extension-capabilities.ts:38`); but `ext/core.ts` is a seven-line shim mounting an HttpApi built on kernel services (`ext/core.ts:6`) and uses none of the verbs; `kernel/` still owns messages, topics, pages, topic move and read marks, about 1,300 lines of domain code |
| 8 long-poll | matches | requery loop gone; waits block on the publication signal; failure still yields the envelope (`kernel/message-wait.ts:17`, `:29`) |
| 9 `mutate()` | matches, best work in the wave | every writer goes through it; nothing calls `boot.reserve` outside it (`kernel/mutate.ts:26`); one idempotency table |
| 21 bootloader rule | partly, intent slipping | `public_paths` projected inside the append transaction (`boot/src/public-paths.ts:27`), `public-pages.ts` at 57 lines, CI guard holds. Against: `page-write-admission.ts` is a new 98-line boot module calling the app over HTTP for page-write policy under both gates with a one-second deadline and 10 ms retry loop (`:87`, `:95`), the loop the decision said would be deleted; boot SSE still present (`public-event-http.ts:99`); `POST /_boot/restart`, `/_boot/metrics`, `revert {withDb}` still missing (`edit-http.ts:107`) |

## Correct before going further

1. **Do the kernel-to-`ext/core.ts` split before any more routes land.** Every handler written against kernel services is code that must be rewritten at the split, and until core consumes the extension verbs nothing pressure-tests whether they are sufficient.
2. **Decide whether boot may call the app for page-write policy.** It sits in the publication path behind two gates; getting it wrong later reopens the freeze and drain semantics, the riskiest code in the repo.
3. **Make the request gate queue instead of refuse.** `boot/src/traffic.ts:69` still passes `rejectFrozen`. Topic move left boot so only database restore uses it, which is exactly why it will be forgotten until a restore returns 503 to a live board.

## Honesty of Codex's docs

Yes, unusually so. The scratchpad refuses to call a wave green off worker checks, names the two-worker Linux run as 371 passed and 22 failed, and says not to describe the retained tests as one all-green run. Items 12 and 13 are marked implemented in `8b3fa7a` and they are. The one generous reading is item 7's checklist row, which describes moving domain code into `ext/core.ts` as ordinary remaining work without saying the mount is currently a shim.

## Reintroductions and new copies

Nothing a decision removed came back. Two additions cut against consolidation: `page-write-admission.ts` adds a fresh boot-to-app HTTP channel with its own retry loop; `boot/src/index.ts` now holds seven null-filled `Ref`s passing eleven positional arguments into `proxy` (`index.ts:40`, `:151`), where item 19.3 asked for one layer graph and four fewer refs. The item 19.5 `admit` renames are untouched.

## Line counts

| Package | at 181939b | at 2979676 | target |
| --- | --- | --- | --- |
| boot src | 9,585 | 9,460 | 7,250 |
| server src (non-test) | 5,049 | 6,093 | — |

Boot deleted 1,390 lines in one commit and gave back nearly all of it in new policy modules, so on this trajectory it does not reach 7,250. The remaining named deletions (SSE, the preparation cache) are worth a few hundred lines, and the item 7 split moves lines into server rather than out of boot.
