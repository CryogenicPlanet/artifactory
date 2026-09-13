# Live-board review check against origin/master

Verification of `docs/pr-1/live-board-review-2026-09-11.md` (13 findings) against `origin/master` at `dd733fe`.
Every file was read through `git show origin/master:<path>`. No edits were made.

Findings 1, 2, 4 and 9 were pre-confirmed by the team lead. Three of those four hold; **finding 9 does not**, and
**finding 1 is half-fixed in the docs**. Both corrections are recorded below with the lines that settle them.

One structural caveat that affects how the whole review should be read: `pages/init.md` and `pages/docs/*.md` are
**editable pages**, not source. The reviewer read a separately launched local deployment whose pages may have drifted
from the tree. That is why the review describes an `/init` "footer" with four links, while `origin/master`'s `init.md`
has three inline links and no footer. Treat page-quoted text in the review as approximate.

---

## Measured facts

Two numbers the review guessed at, now measured.

| Measurement | Value |
| --- | --- |
| `OpenApi.fromApi(Api)` document, app routes only | 214,680 bytes |
| Share of that document that is `responses` | 204,674 bytes (95.3%) |
| App operations described | 11 across 7 paths |
| `"security":[]` occurrences in it | 12 |
| Members in the `errorSchemas` union attached to nearly every operation | 48 |

The full `GET /api` adds `sqlGroup`, `extGroup`, the onboarding group, the subscriptions and standup extension routes,
and boot's 44 manifest route entries merged in by `liveDiscovery`. The review's 387,707 bytes is consistent with that.
The document is large because a 48-member error union is inlined into every operation's `responses` rather than
referenced from `components.schemas`. That is the actual cause, and it is an owner decision (see finding 6).

---

## 1. The recommended first read destroys unread state — PARTLY

**Code: still live.** `ext/core/api.ts:63` enables marking whenever a topic is given
(`query.mark !== "0" && query.topic !== undefined`), and `ext/core/read-view.ts:15` marks through
`Math.max(...visible.map((m) => m.seq))` of the returned items. With `newest=1` those are the highest sequences by
construction, so everything below them is cleared unseen.

**Docs: already fixed in one place, still live in the other.** `pages/docs/recipes.md` now leads its "Recent context"
recipe with `&mark=0`:

```
curl --fail-with-body -sS "$COMMS_URL/api/messages?topic=project&recursive=1&newest=1&limit=50&mark=0"
```

But `pages/init.md:33`, which is the read an agent copies on first contact before it ever opens `recipes.md`, still
reads:

```http
GET /api/messages?topic=project&recursive=1&newest=1&limit=50
```

**Change.** Two separable pieces.

- Documentation, one line: add `&mark=0` to `pages/init.md:33`, matching what `recipes.md` already does. Do this now.
- Code, owner decision: the review is right that the marking rule and `newest=1` cannot both stay as they are. Its three
  options are "`newest=1` marks nothing", "`newest=1` marks only through the lowest sequence returned", and "the recipe
  leads with `mark=0`". The third has now been taken in `recipes.md`, which is why this is PARTLY and not STILL LIVE.
  My recommendation is the first: make `newest=1` mark nothing, in `ext/core/api.ts:63`, by adding
  `&& query.newest !== "1"` to the `enabled` argument. The second option is worse: marking through the *lowest*
  returned sequence still clears unread messages below it that the reader never saw, so it trades a loud bug for a quiet
  one. Overlaps pr-comments item 1 (read marks are automatic) and item 44 (no root mark).

**Size.** Documentation one-line. Code one-line, with an owner decision attached about whether a `newest` read should
mark at all.

## 2. Mention matching fires on URLs and drops backticks — STILL LIVE (settled)

`ext/core/message-mentions.ts:6` is unchanged:

```js
/(?<![\p{L}\p{N}\p{M}@])(@[a-z0-9][a-z0-9._/-]*)(?![/._-])(?=$|[\s\p{P}|])/gu
```

`/` is absent from the lookbehind class, so a trailing URL path segment matches. A backtick is Unicode category `Sk`,
not `P`, so the trailing lookahead drops an inline-code mention.

**Change.** Exactly what pr-comments item 44 already specifies: replace the trailing `(?=$|[\s\p{P}|])` with
`(?![\p{L}\p{N}\p{M}])`, and add `/` and `:` to the lookbehind exclusion. Add the review's seven-row table as test
cases. `pages/docs/recipes.md` carries a paragraph describing the accepted delimiters that will need one sentence
updated alongside it.

**Size.** Small, and already decided. This is item 44's first half verbatim; it is waiting on implementation, not on a
call.

## 3. The obvious mention filter misses your own instance — PARTLY

`pages/docs/recipes.md` now covers it: it gives the agent-wide and instance-wide forms as separate recipes and then
says "Use `mentions=@codex,@codex/job-17,@here` to include both exact mention names."

`pages/init.md` does not. Line 70 shows only the agent-wide form, and line 73 offers the instance form as an
alternative, not a combination:

```
GET /api/messages?topic=@codex&recursive=1&mentions=@codex,@here&exclude_self=1&newest=1&limit=50
Use `topic=@codex/job-17` and `mentions=@codex/job-17,@here` for one instance.
```

An agent that copies the `/init` example and enrolls with a label never receives anything addressed to that label, which
is the review's point.

**Change.** Documentation only, in `pages/init.md:70`. Make the combined form the example:
`mentions=@codex,@codex/job-17,@here`. I agree with the review that the combined form should lead; the two single forms
belong in `recipes.md`, where they already are.

**Size.** One line.

## 4. Two of every five app events are boot bookkeeping — STILL LIVE (settled)

`server/src/events-http.ts` filters only the caller's `types` (line 25) and whatever boot's request-diagnostics
exclusion removes. Nothing drops `seq.reserved`. The events are minted at `boot/src/events.ts:224`.

There is a usable precedent in the tree: `ext/core/message-changes.ts:31` already treats `http.request` and
`seq.reserved` as non-message noise when advancing its follower cursor. The same pair is the exclusion list the app feed
needs.

**Change.** Owner decision on placement, then a small code change. Two options.

- Filter in the app: in `server/src/events-http.ts` and `server/src/stream-http.ts`, drop `seq.reserved` from the
  default result unless the caller asked for it by name in `types=`. Roughly ten lines across the two files.
- Filter in boot: add an `omitReservationEvents` filter to the query surface in `boot/src/events.ts` (which already has
  `omitRequestEvents` at line 334 doing exactly this shape for `http.request`) and set it on the app-facing path in
  `boot/src/public-event-http.ts`. About the same size, and it saves the rows crossing the channel.

I recommend the boot-side filter, because it matches the existing `omitRequestEvents` mechanism line for line and keeps
the bytes off the localhost hop. This is the same boundary question as pr-comments items 32 and 47, so the owner should
settle it there rather than separately.

**Size.** Small either way, with a placement decision attached that items 32 and 47 already own.

## 5. The published OpenAPI declares no authentication — STILL LIVE, but much cheaper than the review implies

**The boot manifest is exactly as described.** `boot/src/route-discovery.ts:231` sets per-operation `security`
(`commsBootSession` for human routes, `commsBootSession` or `commsBootAccess` for `fs` and `read`), line 246 sets
`x-comms-scopes`, and line 255 declares both schemes.

**The app operations carry `security: []`.** The app's `HttpApi` declares no security middleware, so
`OpenApi.fromApi` emits the empty default it initialises at `node_modules/effect/dist/unstable/httpapi/OpenApi.js:314`
and never pushes to. I measured 12 such arrays in the app document.

**The part the review missed.** `server/src/discovery.ts:25` already merges boot's `securitySchemes` into the document
that `GET /api` returns, and `server/src/conversation.ts:23` preserves them. So `commsBootSession` and
`commsBootAccess` are **already present in `components.securitySchemes` of `GET /api`**, and boot's `/api/`-aliased
routes already carry their own `security` and `x-comms-scopes` inside it. Only the app's own operations are missing the
reference. There is nothing to define, only something to attach.

**And the scope data already exists.** `kernel/ext.ts:49` gives every registered route a
`scope: "read" | "write" | "fs"`, and `kernel/extension-mount.ts:79` assigns one to every mounted API operation
(`GET`/`HEAD` to `read`, everything else to `write`). `extension-http.ts:34` already prints it into each route
description as "Requires read." So the projection exists; it is just never emitted as structured OpenAPI.

**Change.** In `server/src/conversation.ts`, where `specification` is assembled (lines 13 to 25), stamp each app
operation with `security: [{ commsBootSession: [] }, { commsBootAccess: [] }]` and `x-comms-scopes: [scope]`, taking
the scope from the registration that produced it. Carry the scope through `extension-http.ts:document` so it reaches
that point; today `document` copies `route.operation` but drops `route.scope` into prose only. `POST /api/sql` sits in
`SystemApi` rather than in a mounted extension, so it needs its scope stated once by hand.

I agree with the review's recommendation and would go one step further: emit `x-comms-scopes` from the same
`route.scope` value that the description already interpolates, so the structured field and the prose cannot drift.

**Size.** Small, around 20 lines, once the scope is threaded through `extension-http.ts`. No design question. The
derived `GET`-means-`read` heuristic in `extension-mount.ts:79` is approximate but it is already what the descriptions
promise, so emitting it changes no contract.

## 6. Bounds are only discoverable inside a 380 KB document — STILL LIVE

**Where the bounds live.** `packages/protocol/src/query-number.ts`:

```ts
export const queryInteger = (minimum: number, maximum: number) => ...
export const QueryCursor = queryInteger(0, Number.MAX_SAFE_INTEGER);
export const QueryLimit = queryInteger(1, 200);
```

`wait` is `queryInteger(0, 60)` at `protocol/conversation.ts:20` and `protocol/events-http.ts:17`.

**Where `query_invalid` is produced.** One place for the declared query schema:
`server/src/request-schema.ts:41-45`.

```ts
yield* Schema.decodeEffect(Schema.toEncoded(endpoint.query ?? ...), { onExcessProperty: "error" })(query)
  .pipe(Effect.mapError(() => new KernelError({ code: "query_invalid" })));
```

Two hand-rolled sites also raise it: `ext/core/api.ts:46` (bad topic, or `newest=1` combined with `wait`) and
`events-http.ts:19` (oversize or repeated parameters).

**Can the hint name the parameter without restructuring the error path?** Yes, with one small addition. The
`Schema.decodeEffect` failure carries an issue tree that names the offending key and its bound; that value is discarded
by the `Effect.mapError(() => ...)` thunk above. What blocks using it is that `KernelError` carries only a code
(`kernel/boot-channel.ts:6`) and `conversation-request.ts` looks the hint up in the frozen `policy` record. The wire
schema is not the obstacle: `errorSchema` in `protocol/errors.ts` already declares `hint: Schema.String`, so a
per-request hint needs no client change.

**Change.** Add an optional `detail: Schema.optional(Schema.String)` to `KernelError`, have `normalize` in
`conversation-request.ts` append it to `policy[code].hint` when present, and populate it at the three `query_invalid`
sites from the decode issue. Then do the review's second suggestion as documentation: add a short bounds table to
`pages/docs/recipes.md` so the common cases need no fetch at all. I agree with both halves of the review's proposal.

**The bigger item the review only gestured at.** "A 380 KB document" is not a hint problem, it is a document problem.
95.3% of the app document is `responses`, because the 48-member `errorSchemas` union is inlined into every operation
instead of being referenced from `components.schemas`. Hoisting it to a `$ref` would cut `GET /api` by roughly an order
of magnitude and would help every client, not just the one that sent a bad `limit`. That is a real change with a design
question attached, and it belongs to the owner.

**Size.** Hint plumbing: small, around 15 to 20 lines across three files. Bounds table: documentation only.
Error-union hoisting: a real change, owner decision.

## 7. One error code covers four unrelated mistakes — STILL LIVE

The four cases split cleanly into two groups.

**The schema already knows the field, for two of them.**

- *Unknown field in the body.* `request-schema.ts:55` decodes the payload with `onExcessProperty: "error"`. The failure
  names the excess key and is then discarded by `Effect.mapError(() => new KernelError({ code: "input_invalid" }))`.
- *Two mutually exclusive shapes in one PUT.* `protocol/topic-management-http.ts:8` declares
  `TopicPayload = Schema.Union([TopicMetaInput, TopicArchiveInput])` with `onExcessProperty: "error"` on both members,
  so `{"meta":{},"archived":true}` fails both branches and the issue names the offending key in each.

Both are free once finding 6's `detail` field exists. They are the same mechanism.

**The schema does not know the field, for the other two.** `protocol/messages.ts:21` declares `MessageInput` with
`topic: Schema.String` and `body: Schema.String` — no pattern, no minimum length. Both are validated later, and in a
single disjunction at `ext/core/messages.ts:37-45`:

```ts
if (
  !validTopic(input.topic) ||
  input.body.length === 0 ||
  input.body.length > 65536 ||
  input.tags?.some((tag) => tag.length > 100) ||
  (input.tags?.length ?? 0) > 100 ||
  (key !== undefined && (key.length < 1 || key.length > 200))
)
  return yield* new KernelError({ code: "input_invalid" });
```

Even the check site does not distinguish which of the six conditions tripped. Splitting that `||` chain into separate
branches, each supplying its own `detail`, covers the bad-topic and empty-body cases and three more the review did not
hit.

**Change.** Depends on finding 6's `detail` field, then: pass the decode issue's key at `request-schema.ts:55`, and
split `ext/core/messages.ts:37-45` into six checks with distinct details. On the review's alternative of splitting the
grammar violation out under its own code, I disagree. A new code obliges every client to learn it and gives no more
information than `input_invalid` plus "topic: must match the path grammar". Naming the field is strictly better and
covers all six conditions rather than one.

**Size.** Small, under 20 lines, conditional on finding 6 landing first. Do them together.

## 8. `archived_by` is not an actor — STILL LIVE, with one correction to the proposed fix

**What it holds.** `ext/core/topics.ts:75-78`:

```ts
archived_by:
  archivedTopics
    .filter((row) => path === row.path || path.startsWith(`${row.path}/`))
    .sort((left, right) => left.path.length - right.path.length)[0]?.path ?? null,
```

The shallowest archived ancestor path, self included. A topic path, never an identity. It sits in the same response
object as `agent` and `instance`, which are identities. The review is right.

**Plain reads really do hide children.** `ext/core/topics.ts:30`:

```sql
AND (${archived ? 1 : 0}=1 OR t.path=${path} OR NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (t.path=a.path OR substr(t.path,1,length(a.path)+1)=a.path||'/')))
```

The requested topic survives via `t.path=${path}`; its descendants do not, because each has an archived ancestor. So
`subtopics` comes back empty and `?archived=1` returns the child. Confirmed.

**Where I disagree with the review.** It says the `topic_archived` hint "explains how to unarchive but never mentions
`archived=1`". That is true of the hint, but `topic_archived` is a **write** refusal. Its hint in
`protocol/errors.ts` is "Unarchive the topic and its archived ancestors before changing it," which is correct advice
for the situation it is raised in. A plain read of an archived parent raises no error at all, so there is no hint to
put the advice in. And the read route already documents it: every `/api/topics` description in
`protocol/topics-http.ts` ends with "Archived children require `archived=1`." The gap is not a missing hint, it is that
the empty `subtopics` list looks like an empty topic rather than a filtered one — and the signal for that is the
non-null `archived_by` sitting right beside it.

**Change.** Two pieces.

- Rename `archived_by` to `archived_root`. It is a response field on `/api/topics`, so it touches
  `ext/core/topics.ts:75`, the topic schema in `packages/protocol`, and any UI that reads it. I prefer `archived_root`
  over the review's other suggestion `archived_via`, because the value really is the root of the archived subtree.
- Add a sentence to `pages/docs/recipes.md`: a non-null `archived_root` with an empty `subtopics` means children are
  filtered, and `archived=1` reveals them. Do not change the `topic_archived` hint.

**Size.** Rename: small, but it is a wire-visible response field, so it needs an owner nod on breaking a published
name. Documentation sentence: one line, do it now.

## 9. Self-echo differs across the three listen surfaces — PARTLY (correcting the settled note)

**This is the one pre-confirmed finding that does not hold as stated.** The team lead's note says "the events route and
the stream route do not" set `excludeMessageInstance`. The events route does. `server/src/events-http.ts:29`:

```ts
...(wait > 0 ? { excludeMessageInstance: ctx.instance } : {}),
```

That value reaches `boot/src/public-event-http.ts:83` and then the filter at `boot/src/events.ts:337-338`:

```sql
(type NOT GLOB 'message.*' OR instance IS NOT ${input.excludeMessageInstance})
```

So `GET /api/events?wait=` on `origin/master` excludes the caller's own `message.*` events, matching the long-poll and
matching the endpoint description in `protocol/events-http.ts:24` ("waiting excludes messages from the caller's
instance before pagination"). Either the reviewer's deployment predated this, or what they saw echoed was a non-message
event such as `seq.reserved`, which this filter deliberately does not touch and which finding 4 is about.

**The stream half is still live.** `server/src/stream-http.ts:31-40` builds its input with no `excludeMessageInstance`
on either the first query or the `wait: 60` follow-up. `/api/stream` echoes your own writes, and neither the endpoint
description nor `pages/docs/stream.md` says so.

**Change.** In `server/src/stream-http.ts`, add `excludeMessageInstance: ctx.instance` to the input, and note the
behaviour in the endpoint description in `protocol/stream-http.ts`. Alternatively expose it as an `exclude_self=1`
query flag on all three surfaces so the choice is the caller's; that is the better long-run shape and matches what
`/api/messages` already offers, but it is a larger change and an owner call.

**Size.** Matching the other two surfaces: one line plus a description. Making it a caller-controlled flag on all
three: small, with a consistency decision attached.

## 10. Webhook deliveries are unsigned — STILL LIVE

`ext/subscriptions/delivery.ts:9-13` is the whole request:

```ts
const request = HttpClientRequest.post(row.input.deliver.url).pipe(
  HttpClientRequest.bodyJsonUnsafe({ subscription_id: row.id, event }),
  HttpClientRequest.setHeader("x-comms-delivery-id", `${row.id}:${event.seq}`),
);
```

One header, no signature. Confirmed.

**The subscription record.** `ext/subscriptions/contract.ts` defines `Stored` as `id`, `instance`, `agent`, `human`,
`input`, `idempotency_key`, `created_at`, `start_seq`, `created_seq`, `deleted_seq`, `cursor`, `attempts`,
`next_attempt`, `last_error`. `created()` in the same file is what the creation response returns: `id`, `filter`,
`deliver`, `created_at`, `since`.

**What a per-subscription secret and an HMAC header would touch.**

- `contract.ts`: a `secret` column on `Stored`, and the secret added to the `created()` response so it is returned
  exactly once at creation.
- `ext/subscriptions/index.ts`: one migration rung adding the column to `webhook_subscriptions`.
- `store.ts`: generate the secret in `create` alongside the existing `crypto.randomBytes(12)` id, and add it to the
  `INSERT`. Take care that the idempotent-replay branch returns the stored row's secret rather than minting a new one.
- `delivery.ts`: compute the HMAC over the serialised body and set the header. The body is currently built by
  `bodyJsonUnsafe`, so it must be serialised once explicitly and both signed and sent, or the signature will not match
  what the receiver parses.
- `response.ts` and `pages/docs/subscriptions.md`: document the header, the signed bytes, and that the secret is shown
  once.

**Change.** I agree with the review's framing that this is a misconfiguration risk rather than an adversary one, and
that it closes cheaply. Sign the exact response body with HMAC-SHA256 and send it as `x-comms-signature`, with a
timestamp in the signed material so a capture cannot be replayed forever.

**Size.** A real change, roughly 40 to 60 lines across five files plus a migration and a docs page. The design question
for the owner is narrow: whether the secret is shown once at creation (simplest, and what I recommend) or readable
later, and whether an existing subscription gets a secret on migration or has to be recreated.

## 11. `/init` links to pages that its readers cannot open — STILL LIVE for agents, improved for browsers

**The links.** `origin/master`'s `pages/init.md` has three, all inline rather than in a footer: `/p/docs/recipes.md`
(line 73), `/p/docs/extensions.md` (line 77), `/p/docs/editing.md` (line 86). `pages/docs/` holds five files, so
`stream.md` and `subscriptions.md` are linked only from `recipes.md`, itself behind the same wall. The review's "footer
links four such pages" does not match the tree; as noted at the top, `init.md` is an editable page and the deployment's
copy had drifted. The substance of the finding survives the discrepancy.

**Are `docs/` paths in any default public-paths projection? No.** The set is built from topic metadata and nothing
else. `boot/src/public-paths.ts:44-46` inserts a path only when a `topic.meta` event carries `meta.public === true`,
and `ext/core/public-page-policy.ts` rebuilds the whole set from `json_type(meta,'$.public')='true'` over published
topics. `boot/src/seed-source.ts` seeds no topics and no metadata. So `public_paths` is empty on a fresh board, and
`pages-http.ts:53` falls through to `identity("read")` for every `/p/` request.

**What changed since the review.** Commit `4766650` ("Redirect unauthenticated page navigations to login instead of
JSON") makes an unauthenticated `GET` carrying `Accept: text/html` redirect to `/auth/login?next=<path>`. A human
clicking a link from `/init` now lands on a login page. An agent, which sends `Accept: */*` or
`application/json`, still gets the JSON 401 `session_invalid` — which is the case the review is about.

**Change.** The review offers two options and I recommend the first: publish the `docs/` paths. Create a `docs` topic
with `meta: {"public": true}` at seed, which puts `docs` into `public_paths` through the existing `topic.meta`
projection with no new mechanism. The onboarding documentation of an anonymous entry point should be readable
anonymously. The alternative, saying in `/init` that the links need a token, is a one-line documentation change but it
leaves a new agent unable to read the recipes until it has enrolled, which is backwards.

**Size.** Seeding a public `docs` topic: small, and it needs an owner decision, because it makes board documentation
world-readable on every deployment. That is almost certainly the intent for `pages/docs/`, but it is the owner's call.
The documentation fallback is one line and needs no decision.

## 12. `/init`'s route list omits the routes `/init` tells you to call — STILL LIVE

**Where the block is generated.** `server/src/onboarding.ts:37-48`, from the `endpoints` argument:

```ts
const routeTable = Object.entries(endpoints).sort(...).map(...).join("\n");
const stable = `${source}\n\n## Live routes\n\n${routeTable}\n`;
```

**Why the boot routes are missing.** `server/src/conversation.ts` builds one `specification` and uses it two different
ways. Line 49 passes it through `liveDiscovery`, which fetches `/.well-known/agent.json` and merges boot's endpoints
in, and returns that from `GET /api`. Line 54 passes the **unmerged** `specification` straight to
`onboardingRoutes`. So `GET /api` has the boot routes and `/init` does not.

**The routes really are aliased and really are in the manifest.** `boot/src/route-discovery.ts` declares
`/api/lock`, `/api/reload`, `/api/revert`, `/api/fs/{path}`, `/api/generations`, `/api/tokens` and
`/api/tokens/{family}/revoke` as `/api/` aliases. Every route the `/init` prose tells the reader to call in section 4
is in that list. An agent trusting the Live routes block over the prose concludes the edit path is absent, exactly as
the review says.

**One correction.** The review says "The list is clearly generated from the extension registry." It is generated from
the merged static spec, which includes the system groups (`/api/sql`, `/api/ext`, `/api`, `/init`, `/init.md`) as well
as the mounted extension routes. The conclusion is unaffected.

**Change.** Make `orientation` build its table from the merged document, the same way `GET /api` does. `liveDiscovery`
needs only `BOOT_URL` and a public unauthenticated `GET`, so it is safe on the anonymous `/init` path; it already has a
1500 ms timeout and fails to `boot_unavailable`. The one thing to get right is the fallback: `/init` must still render
when boot is unreachable, so catch that failure and fall back to the static table rather than letting `orientation`'s
existing `catchCause` turn the whole page into the 503 recovery text. Note that the version stamp is computed from
`source` alone (line 51), not from the table, so a changing route list will not spuriously mark instructions stale.

I prefer this to the review's alternative of labelling the block "extension routes only", which leaves the agent to
discover the edit routes somewhere else.

**Size.** Small, around 15 lines in `onboarding.ts` and `conversation.ts`, with care on the fallback path.

## 13. Page writes report a source error — PARTLY

**The message is still live.** `boot/src/edit-failure.ts:156`:

```ts
message: code === "handler_failed" ? `Handler failed for ${route}.` : "Source edit refused.",
```

One literal for every code in the `policy` record, so a page publish refused for a missing precondition
(`edit-http.ts:341` returns `precondition_required` when a `PUT` has no `baseVersion`) and one refused for stale bytes
both say "Source edit refused." The hints are correct and specific; only the message is wrong. Confirmed.

**The content type is half-fixed.** `server/src/pages-http.ts:31` already returns `text/markdown; charset=utf-8` for a
`.md` read, so `/p/<path>?raw=1` is correct on `origin/master`. But `boot/src/edit-http.ts:318` still returns
`application/octet-stream` for every raw source read, which is what `GET /api/fs/pages/<path>` answers with. So the
finding survives on the boot route.

**Change.** Two pieces.

- Message: in `edit-failure.ts:156`, derive the message from the code rather than using one literal, or at minimum pick
  between "Source edit refused." and "Page publish refused." based on whether the path is under `pages/`. The path is
  available at the `errorResponse` call sites in `edit-http.ts`. I agree with the review that this matters: the docs
  work to keep pages and source apart and the error text undoes it.
- Content type: at `edit-http.ts:318`, special-case `.md` to `text/markdown; charset=utf-8`. Do **not** add a general
  MIME map here. `application/octet-stream` on agent-authored source is a deliberate defence, and the rendered path has
  a CSP (`server/src/html-headers.ts`) precisely because that content is untrusted. Markdown is inert in a browser;
  `text/html` from this route would not be. Keep the change to `.md`.

**Size.** Message: small, and it needs the path threaded to the `errorResponse` call or a second message constant.
Content type: one line, with the scope restriction above.

---

## Recommended order of work

### (a) Do these now — one line or documentation only

1. **Finding 3**, `pages/init.md:70`: make the mention example `mentions=@codex,@codex/job-17,@here`. The single most
   likely day-one mistake, and `recipes.md` already says the right thing.
2. **Finding 1, documentation half**, `pages/init.md:33`: add `&mark=0`, matching `recipes.md`. Stops the first read an
   agent copies from clearing a human's unread counts.
3. **Finding 13, content type**, `boot/src/edit-http.ts:318`: `.md` to `text/markdown`. One line, no decision, and the
   app side already does it.
4. **Finding 9, stream half**, `server/src/stream-http.ts:31`: add `excludeMessageInstance`. One line that makes the
   third listen surface agree with the two that already agree.
5. **Finding 8, documentation half**, `pages/docs/recipes.md`: one sentence saying a non-null archived root with empty
   subtopics means children are filtered and `archived=1` reveals them. Do not touch the `topic_archived` hint.
6. **Finding 6, documentation half**, `pages/docs/recipes.md`: a bounds table for `limit` and `wait`. Covers the common
   cases with no fetch, independent of the hint work below.

### (b) Unambiguous code fixes

7. **Finding 2**, mention grammar. Already decided as pr-comments item 44 and waiting only on implementation. Landing it
   also settles the `recipes.md` delimiter paragraph.
8. **Finding 6 plus finding 7**, the `detail` field. One mechanism serves both: add `detail` to `KernelError`, append it
   in `conversation-request.ts`, then populate it at the `query_invalid` sites and at `request-schema.ts:55`, and split
   the disjunction at `ext/core/messages.ts:37-45`. Do them as one change; doing finding 7 first would build the
   mechanism twice.
9. **Finding 5**, per-operation `security` and `x-comms-scopes`. Cheaper than the review assumed, because the schemes
   are already merged into `GET /api` and every route already carries a scope. Thread `route.scope` through
   `extension-http.ts` and stamp it in `conversation.ts`.
10. **Finding 12**, `/init` route table from the merged document. Mechanically small; the care is all in the
    boot-unreachable fallback.
11. **Finding 13, message half**, `edit-failure.ts:156`. Small once the path reaches the call site.

### (c) Needs an owner decision

12. **Finding 1, code half.** *Decision: should a `newest=1` read advance the read mark at all?* My recommendation is
    no, one line at `ext/core/api.ts:63`. Overlaps pr-comments items 1 and 44, which already own the read-mark model,
    so decide it there.
13. **Finding 4.** *Decision: does `seq.reserved` get filtered in boot or in the app?* Boot already has
    `omitRequestEvents` doing this exact shape for `http.request`, which argues for boot. This is the same boundary
    question as pr-comments items 32 and 47; settle it with them rather than separately.
14. **Finding 8, rename.** *Decision: rename `archived_by` to `archived_root`?* It is a wire-visible response field on
    `/api/topics`, so it is a published-name break, small but not free.
15. **Finding 11.** *Decision: should `pages/docs/` be world-readable by default?* Seeding a `docs` topic with
    `meta.public = true` needs no new mechanism, but it makes board documentation anonymous on every deployment. The
    documentation fallback needs no decision and can ship meanwhile.
16. **Finding 10, webhook signing.** *Decision: is the secret shown once at creation or readable later, and do existing
    subscriptions get one on migration or have to be recreated?* The largest item here, five files plus a migration.
17. **The `/api` document size, which finding 6 only gestures at.** *Decision: hoist the 48-member error union into
    `components.schemas` behind a `$ref`?* It is 95.3% of the app document, measured. This is the change that actually
    makes `/api` fetchable, and it is a real piece of work touching how `errorSchemas` attaches to every endpoint.

### Overlaps with decisions already recorded in `docs/pr-1/pr-comments.md`

- **Item 44** covers finding 2 in full and finding 1's read-mark half. Findings 1 and 2 should be implemented as part of
  item 44, not separately. Note that item 44's other half is also still open: `ext/core/capabilities.ts:110` reads
  `if ((path !== "" && !validTopic(path)) || ...)`, so an empty path is still admitted at the capability level. Core is
  protected because `ext/core/read-view.ts:13` returns early on `topic === ""`, but an extension calling `markRead("")`
  can still write the row that zeroes every unread count.
- **Item 47** (where `http.request` rows live) shares finding 4's boundary. Both ask which process filters
  bookkeeping out of the app feed. Answer them together.
- **Items 32 to 34** (the events split) set the frame for findings 4 and 9. Item 32's decision that `/api/events` and
  `/api/stream` are app routes applying their own filters is exactly the seam where the `seq.reserved` filter and the
  stream's self-exclusion belong.
