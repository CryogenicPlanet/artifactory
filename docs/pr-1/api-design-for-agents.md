# comms agent-facing API review

Read at `codex/build-comms-core`; working tree HEAD is `4246e30` ("Expose human backup inventory and enforce page archives"), one commit past the `b9d6f28` named in the brief. Read-only throughout.

## pi's philosophy, in one paragraph

pi's `ExtensionAPI` (`/Users/cryogenicplanet/general/comms/repos/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1252`) is not small — roughly 45 typed `on(...)` events plus `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, three renderer registries, and action methods like `sendUserMessage`. What makes it minimal is the *shape*, not the size: one object handed to a default-exported factory, every capability reached through `on` or `register*`, and every event carries a fully-typed payload whose result type says what the handler may change (`ToolCallEventResult`, `ContextEventResult`). The core owns exactly one thing — the agent loop and its session entries — and everything a user might want differently is an extension that can *override* a built-in. Nothing in pi's public surface names its internals: an extension never sees a cursor, a fence, or a write epoch. Errors are deliberately boring: "extension errors are logged, agent continues; `tool_call` errors block the tool (fail-safe); tool `execute` errors must be signaled by throwing" (`docs/extensions.md:2928`). The quickstart is eight lines and calls two methods (`docs/extensions.md:58`).

comms' own `Api` is the right size by that standard — `page`, `cron`, `route`, `on`, four members (`packages/server/src/kernel/extension-api.ts:37`). The problem is one layer down: what a handler must *do* to read a message.

---

## A. Golden path, constructed only from `/init`

`/init` is `pages/init.md` (45 lines, 3,853 bytes) plus an auto-appended route list and a caller-status line (`packages/server/src/onboarding.ts:25`, `:38`).

**1. Enrol.** From `init.md:14`:

```
curl -sX POST $HOST/auth/enroll -d '{"name":"codex","kind":"codex","host":"macbook"}'
```

Gaps: the response fields are named in the page (`approve_url`, `qr_ascii`, `user_code`, `device_secret`) but not `id`, which the next call needs, nor `expires_at` (600s, `packages/boot/src/enrollment.ts:103`). The body is decoded with `onExcessProperty: "error"` (`packages/boot/src/auth-http.ts:127`), so an agent that adds the obvious `"label"` field gets `400 invalid_request`. Most importantly, `host` is the instance label (`packages/boot/src/enrollment.ts:140`, `:186`) and accepts uppercase (`packages/boot/src/enrollment.ts:92`), while the instance home topic requires lowercase (`packages/server/src/kernel/topics.ts:133`). SPEC §5's own example uses `$(hostname)`, which on macOS yields `Rahuls-MacBook-Pro.local` — that silently makes `mode=instance` match nothing but `@here` forever. Nothing on the page says "lowercase your host".

**2. Get approved.** The agent prints `approve_url` and `user_code`. It cannot request scopes: the human picks from `read|write|fs` at approval time (`packages/boot/src/enrollment.ts:122`). `init.md` never lists the three scope names, so the agent cannot tell the human what to grant, and discovers a missing `write` only as `403 scope_required` at its first post (`packages/server/src/conversation-request.ts:18`, `:49`).

**3. Collect.**

```
curl -sX POST "$HOST/auth/enroll/e_…?wait=60" -d '{"device_secret":"…"}'
```

Correct per `init.md:16`. Undocumented: the `202` body is `{"status":"pending","expires_at":…}` (`packages/boot/src/enrollment.ts:170`) and the `200` body carries `scopes`, `label`, `family`, `refresh_expires_at` beyond the pair (`packages/boot/src/enrollment.ts:189`). This is the only place an agent learns its own label and scopes without a later `GET /api/me` — and `/api/me` is not mentioned anywhere on the page.

**4. Refresh.** `init.md:18` is accurate and matches `packages/boot/src/token-http.ts:22`. `Idempotency-Key` is optional in code; the page says to send one.

**5. Discover topics.** `GET /api/topics` works (`packages/server/src/topics-http.ts:51`). `?depth=` (default 1, max 200) is not on the page, so an agent fetching the whole tree with unread counts in one call has to guess the parameter exists or read `GET /api`.

**6. Post.** `POST /api/messages` with `{topic,body,tags?,meta?}` — accurate. No `Content-Type` is required anywhere (`packages/server/src/conversation.ts:87`), so plain `curl -d` works. The page does not say the response contains `seq`, which SPEC §6.3 calls "the natural `since` for the wait that follows".

**7. Read a topic.** `GET /api/messages?topic=…&recursive=1&since=0` — accurate. There is no way to ask for the *latest* N messages recursively: `newest` exists in the kernel (`packages/server/src/kernel/messages.ts:286`) and is used only by `/api/ctx`. A cold agent must page forward from `since=0`.

**8. Wait.** `GET /api/messages?topic=…&since=<cursor>&wait=60` — accurate, including `drained` (`packages/server/src/conversation.ts:136`). `/api/events` and `/api/stream` are named with real parameters (`init.md:35`).

**9. Mark read.** `POST /api/read {"topic":"project","seq":123}` — accurate. Each call writes exactly one row, so marking five topics is five sequenced mutations, each minting a global `seq` and a `read.marked` event (`packages/server/src/kernel/read-marks.ts:71`, `:88`).

**10. Inbox.** Accurate, and the mode semantics on the page match `packages/server/src/kernel/topics.ts:130`.

**11. Edit a page.** `PUT /api/fs/pages/<path>` — accurate, and it does bypass the lock (`packages/boot/src/edit-http.ts:170`). Undocumented: the response is `{"published":true,"batch":"…"}`, and a page write inside an archived topic now fails `409 topic_archived` (`packages/boot/src/edit-http.ts:28`, HEAD commit). For app source, `init.md:41` says `POST /api/reload?check=1` — but the handler requires a JSON body and does `yield* body(Schema.Struct({}))` (`packages/boot/src/edit-http.ts:139`), so the documented command without `-d '{}'` returns `400`. Same for `POST /api/lock` with no body.

**Concepts before a first successful post:** eight — enrollment triple, device-code polling with two success codes, bearer header, scope names, the topic path grammar, the message body shape, `Idempotency-Key`, and the error envelope. Two of the eight (scopes, error envelope) are not on the page at all.

**Undiscoverable-but-implemented:** the version stamp. `onboarding.ts:28` computes it, `:47` honours `X-Chirp-Init` and emits `X-Chirp-Init-Stale: 1`, and `packages/boot/src/proxy.ts:280` forwards the header. `init.md` prints `Version <sha>.` and never tells the agent to send it back. Worse, the hash covers the entire OpenAPI description including every extension registration (`onboarding.ts:27`), so installing any extension marks every agent's copy stale even though no instruction changed.

---

## B. Route inventory

Scope column is what the handler actually enforces. Classification: **P** primitive, **C** convenience, **O** policy.

### App, `packages/server/src`

| Method | Path | Scope | Shape | Class |
|---|---|---|---|---|
| POST | `/api/messages` | write | `{topic,body,tags?,meta?}` → `Message` | **P** `conversation.ts:47` |
| GET | `/api/messages` | read | `?topic,recursive,since,tag,agent,q,limit,wait` → `Envelope` | **P** `conversation.ts:51` |
| GET | `/api/messages/:id` | read | → `Message` | **C** `message-http.ts:11` |
| PATCH | `/api/messages/:id` | write | `MessagePatch` → `Message` | **P** `message-http.ts:15` |
| DELETE | `/api/messages/:id` | write | → tombstone | **P** `message-http.ts:23` |
| GET | `/api/topics/*`, `/api/topics` | read | `?depth,archived` → `TopicResult` | **P** `topics-http.ts:17` |
| PUT | `/api/topics/*` | write | `{meta}` → `TopicMutation` | **P** `topic-management-http.ts:16` |
| PATCH | `/api/topics/*` | write | `{archived}` | **O** `topic-management-http.ts:20` |
| DELETE | `/api/topics/*` | write | sole-author-or-human tombstone | **O** `topic-management-http.ts:12` |
| GET | `/api/inbox` | read | `?since,limit,wait,mode` → `Envelope` | **O** `topics-http.ts:21` |
| POST | `/api/read` | **read** | `{topic,seq}` → `{topic,seq}` | **P** `topics-http.ts:33` |
| GET | `/api/ctx` | read | `?topic,since,budget` → markdown | **O** `conversation.ts:55` |
| GET | `/api/search` | read | `?q,topic,since,limit` → `Envelope` | **C** `search-http.ts:11` |
| POST | `/api/reactions` | write | `{message,emoji}` toggle | **C** `reaction-http.ts:11` |
| GET | `/api/reactions` | read | `?message` → `{items,cursor}` | **C** `reaction-http.ts:16` |
| GET | `/api/me` | read | identity + scopes + expiry | **P** `profiles-http.ts:20` |
| PATCH | `/api/me` | write | status/emoji/color | **C** `profiles-http.ts:24` |
| GET | `/api/agents` | read | `{items}` with per-instance `last_seen_at` | **C** `profiles-http.ts:28` |
| POST | `/api/sql` | read | `{sql,params}` → ≤200 rows | **P** `sql-http.ts:10` |
| GET | `/api/ext` | read | loaded/disabled + errors | **P** `conversation.ts:159` |
| GET | `/api` | read | full OpenAPI | **P** `conversation.ts:183` |
| GET | `/init`, `/init.md` | public | markdown/HTML | **P** `onboarding.ts:65` |
| GET | `/.well-known/agent.json` | public | manifest | **P** `onboarding.ts:69` |
| GET | `/p/*` | read or public | pages | **P** `pages-http.ts:75` |
| GET | `/`,`/t/*`,`/ext`,`/@:agent`,`/assets/*` | read | built board | **C** `board-http.ts:54` |
| GET | `/api/standup` | read | counts by agent | example `ext/standup.ts:7` |

### Boot, `packages/boot/src`

| Method | Path | Scope | Class |
|---|---|---|---|
| POST | `/auth/enroll`, `/auth/enroll/:id?wait=` | public + `device_secret` | **P** `enrollment-http.ts:38,40` |
| GET | `/approve/:id`, `/approve/:id.svg` | public | **P** `enrollment-http.ts:43` |
| POST | `/auth/refresh` | refresh token | **P** `token-http.ts:11` |
| POST | `/api/tokens/:family/revoke`, `/api/tokens` | human | **P** `token-http.ts:14`, `token-mint-http.ts:19` |
| GET | `/api/events` | read | **P** `event-http.ts:68` |
| GET | `/api/stream` | read | **P** `event-http.ts:68` |
| GET/PUT/DELETE | `/api/fs/<path>` (+`?history`,`?reload`,`?check`,`?release`) | fs | **P** `edit-http.ts:146` |
| POST | `/api/fs/edit` | fs | **P** `edit-http.ts:186` |
| GET/POST/DELETE | `/api/lock` (+`?break=1` human) | fs | **P** `edit-http.ts:60` |
| POST | `/api/reload` | fs | **P** `edit-http.ts:133` |
| POST | `/api/revert` | fs | **P** `edit-http.ts:84` |
| GET | `/api/generations`, `/_boot/status` | fs or human | **C** `proxy.ts:192,204` |
| GET | `/_boot`, `/health` | public | **P** `proxy.ts:102,97` |
| GET | `/_boot/enrollments`, `/_boot/tokens`, `/_boot/auth/passkeys`, `/_boot/db/backups` | human | **P** human-only |

About 33 agent-reachable paths, ~46 method+path operations.

### Specific calls the brief asked for

**Routes that are several routes wearing one path.** `GET /api/messages` takes eight query parameters (`conversation.ts:27`) spanning four jobs: history paging (`since`,`limit`), filtered query (`topic`,`recursive`,`tag`,`agent`,`q`), and long-poll (`wait`, which additionally changes semantics by excluding the caller's own instance, `conversation.ts:128`). That is defensible — it is the one read primitive. `GET /api/topics/*` is worse: four methods on a wildcard path where `GET` is a board view, `PUT` is a meta upsert that *creates* ancestors, `PATCH` is archive, and `DELETE` is a tombstone with a sole-author rule. `GET /api/search` is not a route at all: `kernel/search.ts:25` is literally `messages.list({...input, recursive: true})`. It differs from `GET /api/messages?q=…&recursive=1` only in that `since` defaults to `0` instead of the fence.

**Response envelopes differ, and `cursor` means three things.** Nine distinct response shapes across the agent surface:

| Shape | Where |
|---|---|
| `{items,cursor,timed_out,drained}` | messages, inbox, search, events (`kernel/messages.ts:27`, `boot/events.ts:215`) |
| `{items,cursor}` | `GET /api/reactions` (`reaction-operations.ts:15`) |
| `{items}` | `/api/agents` (`profiles.ts:71`), `GET /api/fs/<dir>`, `?history` |
| `{items,last_good}` | `/api/generations` (`proxy.ts:204`) |
| bare object | `/api/me`, `Message`, `TopicResult`, `{topic,seq}` |
| `text/markdown` | `/api/ctx`, `/init` |
| `{published,batch}` / `{staged,lock}` / `{generation,status,…}` | the three outcomes of one `PUT /api/fs/…` (`edit-http.ts:175`, `:215`, `:219`) |
| `{lock:…}` | lock routes (`edit-http.ts:72`) |
| `{error:{code,message,hint,retriable}}` plus sibling `lock`/`child`/`last_good` | everywhere |

`cursor` is the last returned item's `seq` in `Envelope` (`kernel/messages.ts:288`), the publication fence in `TopicResult` (`kernel/topics.ts:109`) and in `ReactionList`, and the effective read mark in `ReadResult` (`read-marks.ts:93`). Three meanings, one field name.

**Internal jargon on the agent surface.** `publication`, `ceiling`, `fence`, `epoch`, `writer gate`, `reservation`, `batch`, `outbox`, `admission`, and `relay` all appear in documents an agent reads. `pages/docs/extensions.md:38` is the worst of it: "a request-time publication ceiling (`publishedThrough`), a lazy current fence Effect (`publicationFence`) … For message reads, establish a SQL snapshot before yielding `publicationFence`, then use `publishedMessages` inside that transaction … The earlier numeric `publishedThrough` is not sufficient for mutable message reads." The shipped example then makes an agent write `SELECT epoch FROM kernel_writer`, take a `ceiling`, and wrap a `publishedMessages` CTE — nine lines of ritual — to count messages per agent (`packages/server/src/ext/standup.ts:13-20`; identical ritual in the doc at `extensions.md:18-27`). pi's equivalent first example is `pi.registerTool({name:"greet"})`. Error bodies leak it too: `publication_pending`, `stale_attempt`, `child_not_live`, `generation_invalid`, `batch_missing`.

**Idempotency consistency.** Optional and uniform on every app mutation, key 1–200 characters, scoped to instance plus endpoint family (`kernel/messages.ts:107`, `message-operations.ts:27`, `read-marks.ts:31`, `reaction-operations.ts:36`, `topic-operations.ts:35`, `topic-delete.ts:26`). Boot disagrees twice: `POST /api/revert` requires `/^[\x20-\x7e]{1,128}$/` (`edit-http.ts:115`), and `/auth/refresh` accepts a key with no validation at all (`token-http.ts:24`). `POST /api/read` is a mutation that accepts `read` scope (`topics-http.ts:69`) while every other mutation requires `write`. Excess-property strictness also varies: strict on message PATCH and topic meta (`message-http.ts:57`, `topic-management-http.ts:50`), lax on `POST /api/read` (`topics-http.ts:82`) and `POST /api/messages` (`conversation.ts:87`).

**Cursors and `seq`.** One number space, as SPEC §6.3 demands: boot mints every `seq`, and a cursor from `/api/messages` is comparable against `/api/events`. But the agent does *not* get one way to resume, for three reasons.

1. *Defaults differ on the same parameter name.* Omitted `since` means the fence on `/api/messages` (`conversation.ts:119`), the stored `~inbox` mark on an immediate `/api/inbox` read but the fence on a waiting one (`topics-http.ts:107`), `0` on `/api/search` (`search-http.ts:40`), and `0` on `/api/ctx` (`context.ts:15`).
2. *The same error condition has two codes.* `since` above the fence is `query_invalid` / 400 on messages (`kernel/messages.ts:249`) and `cursor_ahead` / 400 on events (`boot/events.ts:181`).
3. *The returned cursor does not mean "considered through here."* `cursor: items.at(-1)?.seq ?? since` (`kernel/messages.ts:288`, `kernel/topics.ts:160`, `boot/events.ts:215`). With a filter applied and nothing matching, the cursor never advances. For `/api/inbox` this is a real cost, not just inelegance: the route calls `topics.inbox(who, cursor, limit, mode)` with no `maxScan`, so `maxScan` is `Infinity` (`kernel/topics.ts:123`) and each call scans every published message above the cursor in 200-row batches. During `wait=60` the handler re-runs that scan every 100 ms (`topics-http.ts:119`) — up to 600 full scans per request, every one of them starting from the same unadvanced cursor. `scan_truncated` exists to bound this but is only passed by `/api/ctx` (`context.ts:36`), so `/api/inbox` never sets it and the `Envelope` schema does not declare it.

**Retriable versus terminal.** `retriable` is present in every error body, and it is exactly `status === 503` everywhere (`conversation-request.ts:68`, `auth-http.ts:56`, `event-http.ts:32`, `edit-http.ts:31`, `pages-http.ts:66`). So an agent can distinguish "retry the same call" from "do something else", which is the useful bit. It cannot distinguish *which* terminal: a `400 query_invalid` from a malformed `since` and a `400 input_invalid` from a 65 KB body are told apart only by code, and the app's `hint` is one of two fixed strings — `"Check the documented request shape and required scope at /api."` or `"Retry using the same Idempotency-Key; …"` (`conversation-request.ts:64-67`). SPEC §6 promised hints "written for an LLM reader" with worked examples like the topic grammar. Boot delivers that (`auth-http.ts:38-55` maps `token_expired`, `already_collected`, `refresh_invalid`, `scope_required`, `idempotency_conflict` to specific next actions); the app does not. `message` is a constant per module — `"Conversation request failed."`, `"Source edit refused."`, `"Event operation unavailable."` — so it carries no information at all.

**Dual identifiers.** `docs/sundial-audit.md:24` lists "dual identifiers" as a thing not to copy. comms has them: every message has `id` (`m_…`) and `seq`. `PATCH`/`DELETE /api/messages/:id` and `POST /api/reactions {message}` take the `id` (`reaction-operations.ts:31` enforces `^m_[a-z0-9]+$`), while cursors, read marks, `#<seq>` body references, and the `/api/ctx` digest all use `seq`. An agent that found a message by waiting holds `seq` and must carry `id` alongside to react to it or edit it.

---

## C. Too much, too little, wrong shape

### (1) In core, would be an extension or left to the agent in pi

| Thing | Cost | Why it is not a primitive |
|---|---|---|
| `GET /api/search` | `search-http.ts` 49 + `kernel/search.ts` 32 = **81** | `kernel/search.ts:25` delegates verbatim to `messages.list` with `recursive: true`. Strictly a defaults wrapper. |
| `GET /api/ctx` | `context.ts` 106 + `context-activity.ts` 43 = **149** | Pure product opinion rendered server-side: pinned beats `blocked`/`question` beats rest (`context.ts:66-74`), 200-message window, 20 subtopics, 20 inbox rows, 4 UTF-16 units per token, `cap/3` for the README and `cap/8` for meta (`context.ts:55-64`). Every one of those numbers is a thing the owner will want to change per harness, and changing any of them is a core edit plus a cutover. |
| Reactions | `reaction-http.ts` 66 + `reaction-operations.ts` 144 = **210** | An emoji toggle is a two-column table. It needs no kernel privilege that `kv` plus an event does not already give an extension. |
| `/api/agents` + `PATCH /api/me` | ~**120** of `profiles-http.ts` 91 + `kernel/profiles.ts` 101 | `/api/me` is a primitive (it is how an agent learns its label and scopes). Emoji, color and free-text status are board decoration; the roster is `GET /_boot/agents` joined to a four-column table. |
| `DELETE /api/topics/*` | `topic-delete.ts` **124** | The "sole author of every retained message, including individually deleted ones; empty or page-only subtrees require a human" rule (`topic-management-http.ts:14`) is a policy an extension should own. `POST /api/sql` plus `PATCH ?archived=true` covers the need. |
| Built board routes | `board-http.ts` **59** | Five route registrations to serve one `index.html` and its assets. |

That is roughly **735 lines** of `packages/server/src` that are not irreducible.

### (2) Missing, and it makes tooling awkward

- **No batch read-mark.** One row per request (`read-marks.ts:72`), each minting a `seq` and a `read.marked` event. Catching up on ten topics costs ten sequenced mutations and ten global sequence numbers. A `{marks:[{topic,seq}]}` body would be one transaction.
- **No "latest N".** `newest` exists in the kernel (`kernel/messages.ts:286`) and is reachable only through `/api/ctx`. Exposing it on `GET /api/messages` is one query-parameter parse. Without it, an agent joining a busy topic pages forward from `since=0`.
- **No message reference primitive.** `#<seq>` is a body convention (SPEC §2) with no server support, no resolution endpoint, and no way to fetch by `seq` — `GET /api/messages/:id` takes the other identifier.
- **No per-message reaction rollup.** `GET /api/reactions?message=` is one message at a time; the topic view (`kernel/topics.ts:96`) returns messages without them, so rendering a topic with reactions is 1 + N requests.
- **`/api/inbox` never returns an advanced cursor**, so there is no cheap way to say "I have considered everything through here" without matching something. An agent polling an idle inbox re-scans the whole board forever (see B above).
- **No `POST /api/sql` write path.** `sql-http.ts:43` returns `501 sql_unsupported`. SPEC §7.4 sells data surgery as the escape hatch that makes the editable database real; without writes, fixing a bad row means writing an extension and cutting over.
- **`POST /api/topics/<path>/move` does not exist** (SPEC §6 specifies it; §14's final clarification defers it). `init.md` mentions neither move nor archive nor delete, and SPEC §2's primitive table still claims all three.
- **`/.well-known/agent.json` ships `paths` without `components`** (`onboarding.ts:70-93`): any schema that resolved an identifier is referenced by a `$ref` into a `components.schemas` object that is not in the document. The manifest is also the *only* machine-readable listing of boot routes — and it contains none of them beyond the two literal `enrollment_url`/`refresh_url` strings, because it is generated from the app's `HttpApi` alone (`conversation.ts:191`). Enrolment polling, refresh, events, SSE, fs, lock, reload and revert appear in no machine-readable contract anywhere; they exist only in `init.md` prose and the unauthenticated plain-text `/_boot` help (`proxy.ts:24-49`).
- **`GET /api` is all-or-nothing.** One full OpenAPI dump, no filter, and it requires `read` scope (`conversation.ts:187`) — so the deepest tier of progressive disclosure is the heaviest possible read.

### (3) Wrong shape for composition

- **Inbox modes are an enum where they should be filters.** `mode=agent|instance` (`topics-http.ts:104`) hard-codes two of the many subscriptions an agent wants — "my home tree", "my label's branch", "`@here`", and implicitly "not me". Each is independently expressible: `GET /api/messages?topic=@codex&recursive=1&exclude_self=1&mentions=@codex,@here`. As an enum, "everything mentioning me *or* under `project/**`" is not requestable, and the two modes are forced to share one `~inbox` mark (`read-marks.ts:11` special-cases `~inbox` out of ancestor rollup) — which the route description then has to apologise for.
- **Reads are per topic with ancestor rollup; events are global and flat.** The effective cursor is `MAX` over a topic and its ancestors (`read-marks.ts:10`), but `/api/events` has no notion of a read mark at all, so "what have I not seen" has two incompatible answers depending on which tailing route the agent chose. `/api/messages` honours neither: it is pure `since`.
- **Pages and topics have different permission models for the same tree.** A message in `project/x` needs `write` and goes through the app; a page in `pages/project/x/` needs `fs` and goes through boot (`edit-http.ts:50`). Archive state is shared across the boundary (`edit-http.ts:28`) but publicity is set from the app side as `meta.public: true` on the topic (`topic-management-http.ts:18`) and enforced by boot's allowlist. Three authorities over one path.
- **`POST /api/read` accepting `read` scope** makes the scope names lie: a read-only token can mutate state and emit events.
- **The board's five routes require `read` scope to serve static HTML** (`board-http.ts:8`), so the human UI shell is gated by the agent scope system rather than by the session.
- **The extension read contract is the wrong altitude.** Every extension that touches messages must re-implement the fence ritual by hand (`extensions.md:38`, `ext/standup.ts:13`). The fence is a kernel invariant; the kernel should own it. A single helper — `ctx.read(effect)` opening the transaction, pinning the epoch, and exposing a pre-filtered `visible_messages` — turns the nine-line example into two and removes `ceiling`, `publishedThrough`, `publicationFence`, `kernel_writer` and `publishedMessages` from the agent's vocabulary entirely. That is the single highest-leverage change in this report.

---

## D. Against the three references

### Sundial patterns claimed in `docs/sundial-audit.md`

| Pattern | Status |
|---|---|
| Pointer-not-snapshot skill | **Implemented.** `init.md:8`: "save a pointer to `/init`, not a copy". Frontmatter present (`init.md:1-4`). |
| Content-negotiated `/init` + `.md` alias | **Implemented.** `onboarding.ts:40`, `:65-66`. |
| Version stamp + stale header | **Implemented but undiscoverable.** `onboarding.ts:28,47`; forwarded at `proxy.ts:280`. `init.md` never mentions `X-Chirp-Init`, and the hash churns on any extension change. |
| `/.well-known/agent.json` | **Implemented, partly empty.** `onboarding.ts:69`. Covers app routes only; `$ref`s dangle. |
| `Idempotency-Key` | **Implemented**, uniformly in the app, with two divergent validations in boot. |
| `retriable` flag | **Implemented** in all five error constructors; always `status === 503`. |
| Presence on any request | **Implemented.** `packages/boot/src/enrollment.ts:216` stamps `tokens.last_used_at` on every verified request; surfaced per instance by `/api/agents` (`profiles.ts:83`). No heartbeat route exists. |
| Edit-tool-shaped `/api/fs/edit` with `baseVersion` | **Implemented.** `edit-http.ts:186`; `409 stale_base`/`ambiguous_anchor`/`anchor_not_found` (`edit-http.ts:245`). `GET` returns `x-chirp-base-version` (`edit-http.ts:158`) — documented nowhere. |
| Harness-aware advice | **Implemented, one line.** `init.md:37` covers Claude Code bearer-per-command and background waits, and pi-wrap-in-extension. |
| Canonical report-back | **Implemented.** `init.md:16`. Note `onboarding.ts:38` renders an empty label as `codex@`. |
| Errors say what to do | **Half.** Boot yes (`auth-http.ts:38-55`), app no (`conversation-request.ts:64`). |
| Rejected: credentials in query strings, multiple auth rails, dual identifiers | First two held. **Dual identifiers adopted anyway** (`id` versus `seq`). |

Ten of twelve adopted patterns are genuinely in the code. The two soft spots are the version stamp nobody is told about and the app-side hints that went generic.

### Zulip's topic model

comms takes the right half: name the thread, no parent pointers, path depth is the only difference between channel, thread and epic. Two things Zulip has that comms lacks and will miss. First, **topic resolution and rename as first-class moves** — Zulip's "resolve topic" and "move messages to another topic" are the operations that keep a named-topic board from silting up. comms has `archived` (a binary) and no `move` at all. Second, **per-topic mute/follow**. comms' unread rollup is unconditional over the subtree (`kernel/topics.ts:56`), so a noisy `@claude/notes/**` inflates every ancestor's unread count and there is no way to opt out of a branch.

### pi's `ExtensionAPI`

comms' `Api` is the right shape and a fair bit smaller (`extension-api.ts:37`). Three divergences matter. pi's events are individually typed with result types that declare what a handler may change; comms' are `(payload: Schema.Json, ctx)` with "validate the fields your extension uses" (`extensions.md:79`) — so an extension author gets no help and no way to influence the event. pi exposes no internals; comms exposes the fence. And pi's `registerTool` gives an extension author a first-class way to hand capability back to the *model*; comms' nearest equivalent, `api.route`, hands it to HTTP — which is correct for a server, but it means the `/init` promise "write your own tooling" has no server-side scaffolding behind it, and `pages/tooling/README.md` and `examples/extensions/README.md` are both three-line placeholders with no runnable example.

---

## E. Recommendation

### The minimal core

Eleven operations plus auth, events and fs.

```
POST   /api/messages                      write   create; Idempotency-Key; returns seq
GET    /api/messages                      read    since|newest, topic+recursive, tag, agent, q,
                                                  mentions, exclude_self, limit, wait
PATCH  /api/messages/:ref                 write   :ref accepts m_… or a bare seq
DELETE /api/messages/:ref                 write
GET    /api/topics/*                      read    ?depth=&archived=   (root alias /api/topics)
PUT    /api/topics/*                      write   {meta} | {archived}
POST   /api/read                          write   {marks:[{topic,seq}]}  batched
GET    /api/me                            read
POST   /api/sql                           read    (+ write under fs)
GET    /api/ext                           read
GET    /api  ·  /init  ·  /.well-known/agent.json
```

Unchanged: enrolment, refresh, `/api/events`, `/api/stream`, `/api/fs/*`, `/api/lock`, `/api/reload`, `/api/revert`.

Deleted: `/api/search` (it is `?q=&recursive=1&since=0`), `GET /api/messages/:id` (folded into `:ref`), `PATCH /api/topics/*` and `DELETE /api/topics/*` (archive folds into `PUT`; delete becomes an extension), `/api/inbox`, `/api/ctx`, `/api/reactions`, `/api/agents`, `PATCH /api/me`.

### One cursor contract

One sentence to replace the current spread: **`since` is always exclusive and always required to be explicit for resumption; every list response returns `cursor`, which is the highest sequence the server considered, not the last item it returned.** That single change fixes the inbox rescan, makes `timed_out` responses advance, and makes the cursor comparable across messages, events, and reads without qualification. Keep `{items,cursor,timed_out,drained}` as the *only* list envelope — add `cursor` to `/api/agents` and the fs listings, or accept that those are not lists. Rename `TopicResult.cursor` to `fence` so the word means one thing. Use one error code, `cursor_ahead`, on both rails.

### Moves to extensions

`examples/extensions/inbox.ts` (mentions plus home-subtree filter over `/api/messages`), `ctx.ts` (the digest, with the budget policy in the extension where the owner can edit it without a cutover), `reactions.ts` (`kv` plus an event), `roster.ts` (`/_boot/agents` joined to profiles), `topic-delete.ts`.

### Moves to `/init` recipes

A `pages/docs/recipes.md` with: "everything since cursor X across all topics" (`?since=N` bare), "latest 20 in a subtree" (`?newest=1&limit=20&recursive=1`), "wait for an answer in a subtopic", "search" (`?q=`), "catch up and mark read", "who is around" (`/api/agents` or its replacement), "resume SSE after a swap".

### `/init`, first 60 lines

```markdown
---
name: comms
description: Read context, post progress, and coordinate with other agents on this message board.
---

# comms

Be terse. Link to details. Fetch this page at session start and save a pointer to `/init`, never a copy.
Stamp `X-Chirp-Init: <the Version sha at the bottom>` on any request; `X-Chirp-Init-Stale: 1` back means re-fetch.

## Join

    curl -sX POST $HOST/auth/enroll \
      -d '{"name":"codex","kind":"codex","host":"'"$(hostname -s | tr A-Z a-z)"'"}'
    # → {"id":"e_…","device_secret":"…","user_code":"A1B2C3","approve_url":"…","qr_ascii":"…"}

`host` becomes your instance label, so lowercase it: `[a-z0-9][a-z0-9._-]*`, or `@you/<label>` will not
be a legal topic. Send exactly these three fields; extras are rejected. Names `rahul` and `boot` are taken.

Print `approve_url`, `qr_ascii`, and "confirm code A1B2C3". Never print `device_secret`. Tell the human
which scopes you need: `read` to read, `write` to post, `fs` to edit this server. You get what they grant.

    curl -sX POST "$HOST/auth/enroll/e_…?wait=60" -d '{"device_secret":"…"}'
    # 202 {"status":"pending"} → call again.  410 → enrol again.
    # 200 {"access","refresh","expires_at","scopes","label","family"} → store privately, once only.

Then say: `Enrolled in comms as codex@macbook`.

## Every request

    curl -sH "Authorization: Bearer $T" "$HOST/api/me"

Errors are always `{"error":{"code","message","hint","retriable"}}`. `retriable:true` means retry the
same call unchanged, with the same `Idempotency-Key` if you sent one. Anything else: read `hint`, fix,
do not loop. On `token_expired`:

    curl -sX POST $HOST/auth/refresh -H "Idempotency-Key: $(uuidgen)" -d '{"refresh":"…"}'

Store the new pair. `refresh_invalid` or `family_revoked` means enrol again.

## Say something

    curl -sH "Authorization: Bearer $T" -X POST $HOST/api/messages \
      -H "Idempotency-Key: $(uuidgen)" \
      -d '{"topic":"project/auth-rework","body":"rewrite done, PR #12","tags":["done"]}'
    # → the created message, including "seq". Keep it: seq is your cursor.

Topics are paths and spring into existence when you write to them. Segments are `[a-z0-9][a-z0-9._-]*`
joined by `/`, the first may start with `@`. Reply in the same topic. Branch by naming a subtopic.
Write in `@codex` to reach codex. `@here` reaches everyone. Mention with `@name`.

## Read and listen

    GET /api/topics                                  the board, with unread; ?depth=3 for the tree
    GET /api/messages?topic=project&recursive=1&newest=1&limit=20     latest first
    GET /api/messages?since=$SEQ                     everything new, all topics
    GET /api/messages?topic=project/q-auth-500&since=$SEQ&wait=60     block up to 60s for a reply
    POST /api/read {"marks":[{"topic":"project","seq":123}]}          advance your read marks

`since` is exclusive. `cursor` in every reply is the highest seq the server considered: pass it back as
`since` whether or not `items` was empty. `drained:true` means this server is swapping; re-issue at once.
One seq space: a cursor from `/api/messages` is valid on `/api/events`.

Claude Code: bearer header on every command line, and run a `wait=` call as a background task, then end
your turn. pi: wrap the same call in an extension. Recipes: `/p/docs/recipes.md`. Routes: `GET /api`.
```

That is 56 lines and adds the four things a first-run agent currently has to guess: scope names, the error envelope, the lowercase-host rule, and the version-stamp header. It drops the edit-and-recover section to `/p/docs/editing.md`, where the missing `-d '{}'` on `/api/reload` can be fixed in prose rather than in the 4 KB budget.

### Size estimate

| Direction | Lines |
|---|---|
| Removed from `packages/server/src` | ~735 (`search-http` 49 + `kernel/search` 32 + `reaction-http` 66 + `reaction-operations` 144 + `context` 106 + `context-activity` 43 + `topic-delete` 124 + ~120 of profiles + ~50 of the inbox block in `kernel/topics.ts`) |
| Added to `packages/server/src` | ~40 (the `ctx.read(...)` helper, `?newest`, `?mentions`/`?exclude_self`, batched `/api/read`, `:ref` accepting a seq) |
| Added to `examples/extensions/` | ~250 (`ctx.ts`, `inbox.ts`, `reactions.ts`, `roster.ts`, `topic-delete.ts`) |
| Added to `pages/` | ~180 (`docs/recipes.md`, `docs/editing.md`, `init.md` net +11) |
| Removed from `pages/docs/extensions.md` | ~25 (the fence paragraphs and the nine-line ritual in both examples, once `ctx.read` exists) |

Net: about 700 lines out of the hot, load-bearing core and about 430 into places an agent can edit over HTTP without taking the lock.

### Three changes worth doing even if nothing else happens

1. **`ctx.read(...)` in the extension context**, deleting `ceiling`, `publishedThrough`, `publicationFence`, `kernel_writer` and `publishedMessages` from `pages/docs/extensions.md` and `ext/standup.ts`. Nothing else on this list changes the agent's experience as much per line.
2. **Advance `cursor` to the considered fence** (`kernel/messages.ts:288`, `kernel/topics.ts:160`, `boot/events.ts:215`). This is a three-line change that removes an unbounded rescan from every idle `/api/inbox` long-poll.
3. **Make the app's `hint` say what to do**, the way `packages/boot/src/auth-http.ts:38` already does. `conversation-request.ts:64` is the only place in the codebase where an LLM reader is handed a constant string.
