# comms review: Effect idiom + over-abstraction

Read at `b9d6f28`, branch `codex/build-comms-core`. Measured sizes:

| Tree | Lines | Files |
|---|---|---|
| `packages/boot/src` | 7248 | 61 |
| `packages/server/src` (incl. `kernel/`) | 4397 | 47 |
| `packages/ui/src` | 3446 | — |
| `packages/*/test` | 9532 | 71 |

Largest files: `server/src/kernel/ext.ts` 442, `boot/src/auth.ts` 356, `boot/src/edit-lock.ts` 351, `boot/src/proxy.ts` 345, `server/src/kernel/messages.ts` 333. Nothing exceeds tech.md's 400-line rule except `ext.ts`.

**One premise in the brief needs correcting before the scores make sense.** The vendored Effect at `repos/effect/packages/effect/src` has no `ServiceMap.ts`; the module is `Context.ts`, and `Context.Service<Self, Shape>()("Id")` is the documented v4 class-service idiom — it appears verbatim in the doc example at `repos/effect/packages/effect/src/Context.ts:186-190`. So comms' 23 `Context.Service` declarations are not legacy; they are correct. I scored against the real rc.113 surface.

---

## Part 1 — How idiomatic is the Effect?

### Rubric

| Area | Score | One-line verdict |
|---|---|---|
| Service definition | 4/5 | Right mechanism everywhere; shape is inferred rather than declared |
| Layer composition | 2/5 | One package composes layers in 3 nested `Effect.provide` tiers plus 4 null-holding `Ref`s |
| Typed errors | 3/5 | 15 `Schema.TaggedError` classes, zero throws in server code — but the 4 most-used carry `code: Schema.String` |
| Error channel discipline | 2/5 | Every server route ends in a `catchCause` that flattens E to a string |
| Scope / resource lifetime | 5/5 | `child-keeper.ts` is textbook; `Scope`, `addFinalizer`, `makeTempDirectoryScoped` used correctly throughout |
| HttpApi usage | 2/5 | Declared with full Schema, then 19/19 handlers are `handleRaw` with hand-rolled parsing |
| Schema at boundaries | 4/5 | Every DB row decoded through Schema; responses all `jsonUnsafe` |
| Stream / Queue / PubSub | 2/5 | `Stream` in 16 files, but 0 `PubSub`, 0 `Latch`, 1 `Queue`; 13 `Effect.sleep` poll sites |
| No `runPromise` in services | 5/5 | Zero in `boot/src` and `server/src`; all 15 occurrences are in React effects, which is correct |
| Concurrency modelling | 4/5 | `Semaphore` in 15 files for real gates; undercut by the poll loops and 3 mutable flags in `cutover.ts` |
| Ref vs module state | 5/5 | Zero module-level `let` or `var` across all packages |

### What is genuinely good

`packages/boot/src/child-keeper.ts` (65 lines) is the best file in the repo: `Config.Redacted` → `Schema.decodeEffect`, `Scope.make()` with an explicit `addFinalizer` that writes a durable closure receipt, `Stream.run` for stdout/stderr forking, and `Effect.raceFirst(child.exitCode, stdin.runDrain)` to make parent-pipe EOF the kill signal. No escape hatches.

`packages/boot/src/edit-lock.ts` is the second best. `EditRejected` at `edit-lock.ts:38-48` uses `Schema.Literals` for its nine codes, so `catchTag` plus a switch is exhaustive. The `admit` combinator at `edit-lock.ts:131-165` owns the transaction, the authority re-check and the expiry sweep, and deliberately returns the domain rejection **as a value** so that cleanup commits even when the request is refused — the reason is stated at `edit-lock.ts:131`. That is a real invariant that a naive `Effect.fail` would break.

`packages/server/src/kernel/extension-work.ts:10-33` normalizes `Effect | Promise | value` from user extension code into one typed-error Effect in 24 lines. pi's equivalent wrapper layer is 45 lines in `core/extensions/wrapper.ts`. Comparable, and correct.

### Top 8 "this is not how you write Effect v4"

**1. Four null-holding `Ref`s stand in for a Layer (`boot/src/index.ts:32-35`).**

```ts
const auth = yield* Ref.make<Auth["Service"] | null>(null);
const events = yield* Ref.make<Events["Service"] | null>(null);
const editing = yield* Ref.make<Editing | null>(null);
const publicPages = yield* Ref.make<PublicPages["Service"] | null>(null);
```

Services are built inside a nested `Effect.provide` at `index.ts:74-87`, then stuffed into these `Ref`s at `index.ts:46-55` so `proxy`, constructed *outside* that scope at `index.ts:106`, can reach them. Every consumer then pays `yield* Ref.get(authStore)` and a null check (`proxy.ts:97`, `proxy.ts:120`, `proxy.ts:126`, `proxy.ts:136`). `server.ts:62-65` repeats the pattern with three more.

Idiomatic rewrite — build the listener *inside* the layer scope so the services are simply in context:

```ts
const app = Effect.gen(function* () {
  const auth = yield* Auth;            // no Ref, no null
  const events = yield* Events;
  yield* HttpRouter.add("*", "/*", proxy).pipe(HttpRouter.serve, Layer.build);
  return yield* Effect.never;
});
yield* app.pipe(Effect.provide(Layer.mergeAll(authLayer(options.auth), eventsLayer, /* … */)));
```

`proxy` then reads `yield* Auth` directly and its 7 positional parameters (`proxy.ts:73-81`) collapse to zero. The 503 `boot_unavailable` path stays, expressed as a `Layer.catchCause` on the layer graph rather than a null check at every call site.

**2. Three nested `Effect.gen` + `Effect.provide` tiers instead of one layer graph (`boot/src/index.ts:39`, `:42`, `:45`).** The bodies open at lines 39, 42 and 45 and close with `.pipe(Effect.provide(...))` at lines 74, 90 and 97 — SQLite on the outer tier, the service bundle on the inner. tech.md §11 says "Layers compose in exactly one place per package". Idiomatic:

```ts
const layers = Layer.mergeAll(generationsLayer, authLayer(options.auth), eventsLayer, /* … */)
  .pipe(Layer.provide(SqliteClient.layer({ filename, disableWAL: true })));
yield* program.pipe(Effect.provide(layers));
```

One graph, one place, and `Layer` memoizes shared dependencies for you instead of the hand-threaded `Layer.provide(eventsLayer)` repeated four times at `index.ts:79-85`.

**3. `handleRaw` on all 19 HttpApi handlers, so the declared Schemas never run.** Count: 19 `handleRaw`, 0 `handle`. `message-http.ts:17` declares `payload: MessagePatch`; `message-http.ts:55` then re-decodes the body by hand. `conversation.ts:51` declares `query`; `conversation.ts:100-129` re-validates the same eight params manually with a bespoke `integer()` helper and returns `query_invalid`. `success: Message` is declared and every response goes out through `HttpServerResponse.jsonUnsafe` (90 occurrences across both packages). The HttpApi declaration is OpenAPI documentation only.

```ts
.handle("update", ({ params, payload }) =>   // payload already decoded & 413-checked
  Effect.flatMap(Messages, (m) => m.update(yield* identity("write"), params.id, payload)))
```

The byte cap is the stated reason for `handleRaw`, and it belongs in the Api declaration, not in 10 copies of a stream-counting loop.

**4. The same 14-line body-reading block is pasted into 10 files.** `bytes += chunk.byteLength` appears at `boot/src/event-http.ts:41`, `boot/src/edit-http.ts:263`, `server/src/sql-http.ts:28`, `server/src/message-http.ts:48`, `server/src/conversation.ts:79`, `server/src/topic-management-http.ts:40`, `server/src/profiles-http.ts:47`, `server/src/topics-http.ts:75`, `server/src/reaction-http.ts:32`, `server/src/kernel/health.ts:52`. Each is `Stream.tap` counting bytes, `Stream.runCollect`, `Effect.timeout("5 seconds")`, `Buffer.concat`, `Schema.decodeEffect(Schema.fromJsonString(S))`, `mapError(() => new KernelError({code:"input_invalid"}))`.

```ts
export const jsonBody = <S extends Schema.Top>(schema: S, limit: number) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((r) => Stream.runFold(Stream.takeUntil(r.stream, …), …)),
    Effect.timeout("5 seconds"),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    Effect.mapError(() => new KernelError({ code: "input_invalid" })),
  );
```

~125 lines deleted.

**5. `failure()` erases the typed error channel at every route (`server/src/conversation-request.ts:27-75`).** It is `Effect.catchCause`, then manual walking of `cause.reasons`, then a five-deep nested ternary mapping a *string* code to a status (`conversation-request.ts:49-57`), then one of two hardcoded `hint` strings. tech.md §5 promised "errors are `HttpApiError` schemas with `code`, `message`, `hint`, `retriable`, so the LLM-readable hint is part of the type". It is the inverse: `message` is the constant `"Conversation request failed."` for all 24 distinct `KernelError` codes, and the default branch is 503 `retriable: true`, so a typo'd code or a genuine 500 is reported to the agent as a retriable outage. Line 45 re-tests `Schema.is(KernelError)` on a value line 37 already filtered.

```ts
export class KernelError extends Schema.TaggedError<KernelError>()("KernelError", {
  code: Schema.Literals(["scope_required", "topic_not_found", /* …24 */]),
}) {}
const STATUS: Record<KernelError["code"], number> = { scope_required: 403, /* … */ };
//  ^ adding a code without a status is now a compile error
```

Attach them as `HttpApiEndpoint.addError(KernelError, { status })` so HttpApi encodes them and OpenAPI documents them.

**6. `code: Schema.String` on the four most-used errors.** `AuthError` (`auth.ts:39-41`, 31 distinct codes in practice), `KernelError` (`kernel/boot-channel.ts:4`, 24 codes), `EventError` (`events.ts:24`), `ChildError` (`child-process.ts:5-6`), `TrafficError` (`traffic.ts:15`). Meanwhile the *less*-used `EditRejected` (`edit-lock.ts:38`), `SourceRejected` (`source-schema.ts:5`) and `PageRejected` (`kernel/pages.ts:10`) correctly use `Schema.Literals`. The typing is inverted relative to blast radius: the errors crossing every HTTP boundary are the untyped ones. Changing `Schema.String` to `Schema.Literals([...])` on those five is mechanical and makes every `includes(code)` test in `conversation-request.ts` exhaustiveness-checked.

**7. Thirteen `Effect.sleep` poll loops where `Latch`, `Deferred` or `PubSub` is the primitive.** Zero `PubSub`, zero `Latch`, zero `Fiber`, zero `SubscriptionRef` in the whole repo. Worst three:

- `server.ts:220` — `while ((yield* Ref.get(lifecycle.mutations)) !== 0) yield* Effect.sleep("10 millis")` busy-waits for in-flight mutations to drain during a freeze. This sits directly inside the cutover window that SPEC measures.
- `supervisor.ts:218-223` — the supervise loop polls `Ref.get(current)` every 100 ms waiting for a child to exist.
- `conversation.ts:135-140` and `topics-http.ts:117-119` — the long-poll re-runs the full `messages.list` SQL query every 100 ms for up to 60 s, duplicated across two files.

For the drain: `lifecycle.mutations` is already gated by a `Semaphore`. Replace the counter with `Semaphore.make(n)` and acquire all permits, or a `Latch` opened when the count reaches zero:

```ts
// freeze: acquire every permit, which can only succeed once all mutations released theirs
yield* lifecycle.slots.withPermits(MAX_CONCURRENT_MUTATIONS)(Effect.void);
```

For the long-poll: one `PubSub` published on commit, consumed as `Stream`, merged with the existing `Stream.tick` heartbeat — which `conversation.ts:144-149` already does correctly for heartbeats, so only the inner wait changes. tech.md §5 says long-poll should be "implemented once as a `Stream`"; it is currently implemented twice as a sleep loop.

**8. Mutable flags defeat the type system in `cutover.ts`, forcing three `Effect.die`s and two IIFE casts.** `let candidate`, `let generation` (`cutover.ts:105-106`) and `let priorClosed` (`cutover.ts:109`) are assigned inside the nested `perform` effect. Because TypeScript cannot narrow them afterward, the code resorts to:

```ts
if (!candidate || !generation) return yield* Effect.die("Missing candidate");  // :191, :199, :210
const failedGeneration = ((): Generation | null => generation)();             // :226
const failedCandidate  = ((): ActiveChild | null => candidate)();             // :232
```

Three `Effect.die` calls exist purely to satisfy the compiler about state the author knows is set. Have `perform` return `{ candidate, generation, result }` and have the failure path read them from the `Exit`, or hold them in a `Ref` and `Ref.get` them in the recovery branch. Removes 3 dies, 2 IIFEs, ~15 lines.

Bonus, same file: `const optionsSource = options;` at `cutover.ts:296` is declared at the *bottom* of the function but used at lines 119, 120 and 167 above it. It exists only because `reload`'s own `options` parameter (`cutover.ts:94`) shadows the outer one. Rename the parameter to `request`. One line, zero risk, removes a genuine head-scratcher.

### Secondary observations

- **Service shapes are inferred, not declared.** 13 of 23 services use `Effect.Success<ReturnType<typeof make>>`. For most that is harmless. For `Auth` it is not: `auth.ts:331-352` builds the service by spreading five sub-service objects (`...accounts, ...enrollment, ...tokens, ...passkeys, ...mint`) plus 12 named members. There is no single place that states what `Auth` exposes, and `grep` cannot find where a member comes from. Declare the shape as an interface, as the vendored doc example does.
- **Five import cycles, all through `auth.ts`.** `auth.ts` ↔ `enrollment.ts`, `lock-break.ts`, `passkey-management.ts`, `token-mint.ts`, `tokens.ts`. Each sub-feature imports `AuthError` from `auth.ts` while `auth.ts` imports its `makeX` factory. This is the direct cause of the `*-schema.ts` files in Part 2.
- **The "commit the refusal" idiom is spelled four different ways.** `tokens.ts:86-91` (`committed`), `lock-break.ts:45-55`, `passkey-management.ts:129-133` and `:151-154`, `enrollment.ts:151`, `edit-lock.ts:162-165` (via `Result.fail`/`Effect.fromResult`). Five of the six carry an `oxlint-disable effecttsgo/flat-map-conditional-to-filter-or-fail`. Export `committed` from one file; the lint suppression then lives in one place instead of five.
- **`events.query` filters twice.** `events.ts:184-191` filters topic/actor/instance/level/types in SQL; `events.ts:196-211` re-applies the same five predicates in TypeScript over the returned rows. One of the two is dead.
- **`HealthProbe` is a mode flag in a Context slot.** `Effect.serviceOption(HealthProbe)` at `kernel/messages.ts:110`, `:230`, `kernel/pages.ts:39`, `context-activity.ts:9` makes the production write path branch on whether a health probe is in flight — `messages.ts:111` skips `relay` and `:157` writes a reservation only when the probe exists. Ambient optional services that change committed behaviour are hard to reason about; pass an explicit mode into `create`.
- **Two migration systems coexist.** `kernel/database.ts:10-89` is an inline `PRAGMA user_version` ladder for v1→v6 ending in 12 `SELECT … LIMIT 1` shape assertions (`database.ts:74-86`); `kernel/migrations.ts` is a full `Migrator.fromGlob` loader pointed at `src/migrations/`, which contains only `README.md`. Both run, in that order, at `server.ts:79-80`.

---

## Part 2 — How much is over-abstracted?

### pi as the baseline (measured)

pi's `coding-agent/src` is 70052 lines in 258 files; `interactive-mode.ts` alone is 6620 and `agent-session.ts` 3552. Its style: 6 function hops from `main()` to calling a user's extension factory, every hop doing real work; plain verb names (`loadExtensions`, `emitToolCall`, `createContext`); `undefined` as "no change" instead of a wrapper; one very wide interface (`ExtensionAPI`, 62 declarations in one file at `core/extensions/types.ts:1252-1506`) rather than many narrow ones; errors thrown near the fault and returned as values at subsystem boundaries; and across all 258 files, `Receipt` 0, `Envelope` 0, `Descriptor` 5 (four of which are `Object.getOwnPropertyDescriptors`), `Transition` 3 (one private field). Its entire tool-wrapping layer is 92 lines in two files. Its only `*-types.ts` split is `modes/rpc/rpc-types.ts`, which exists because it is a cross-process wire contract.

Two things pi does that comms correctly does *not* copy: 6620-line files, and one 1797-line types file.

### Request path traces

**POST /api/messages** — 13 hops, two processes:

| # | File:function | Work done |
|---|---|---|
| 1 | `boot/src/index.ts:106` `HttpRouter.add("*","/*")` | single catch-all route |
| 2 | `boot/src/proxy.ts:82` `proxy` | 7 sequential route probes (`proxy.ts:108-119`), auth, reserved-prefix check |
| 3 | `boot/src/traffic.ts` `admit` | write-freeze gate, returns destination |
| 4 | loopback HTTP | header rebuild + identity headers (`proxy.ts:251-274`) |
| 5 | `server/src/server.ts:196` `serveEffect` | secret compare, `/_kernel/control` check, `Ref.get(installed)` |
| 6 | `server/src/server.ts:134` installed handler | lifecycle state check, `acquireUseRelease` mutation admission |
| 7 | `server/src/conversation-request.ts:27` `failure` | wraps everything, flattens errors at the end |
| 8 | `server/src/kernel/ext.ts` `dispatch` | extension route interception |
| 9 | `HttpRouter` → `HttpApiBuilder` | routing |
| 10 | `server/src/conversation.ts:70` `handleRaw("create")` | `identity()`, 14-line body read, decode |
| 11 | `server/src/kernel/messages.ts:98` `create` | validation, transaction |
| 12 | `server/src/kernel/boot-channel.ts:95` `request` | **HTTP back to boot** to reserve event sequence |
| 13 | `boot/src/events.ts:123` `reserve` → `:57` `append` | SQL |

Hops 3-6 and 12 are required by the spec's two-process, durable-cutover design — not abstraction. The avoidable layers are 7 (see item 5 above) and half of 10.

**A source edit (PUT /api/fs/app/x then POST /api/reload)** — 11 hops:

`proxy.ts:151` `editRoute` → `edit-http.ts:37` (route rewrite `/api/` → `/_boot/`, `edit-http.ts:41`) → `edit-http.ts:55` `authoritative` (re-authenticates, provides `EditAuthority`) → `source-files.ts:138` `read`/`stage` wrapped in `guard` (`source-files.ts:32`, semaphore + journal-ready) → `edit-lock.ts:246` `stage` → `stageBatch` (`edit-lock.ts:168`) → `admit` (`edit-lock.ts:131`, transaction + expiry + authority) → SQL. Then reload: `cutover.ts:92` `reload` → `sources.prepare` → `lock.pin` → `sources.materialize` → `snapshots.create` → `supervisor.launch` (rehearsal) → `sources.publish` → `source-journal.ts` `begin`/`recover` → `supervisor.launch` (candidate) → `traffic.freeze` → backup → `generations.healthy` → `activate` → `lock.finish`.

Long, but I could not find a hop that does no work. `guard`, `admit`, `pin`/`finish` and `materialize` each own a distinct durability step that SPEC requires.

### Abstraction table

| Abstraction | Files / lines | What it protects | Verdict | Est. lines saved |
|---|---|---|---|---|
| `failure()` error flattener | `conversation-request.ts:27-75` (49) | Nothing — it *discards* the E channel and the per-error hint | **Replace** with typed `KernelError` codes + `addError` | ~25, plus every handler gets a real hint |
| 10× body-read block | 10 files, ~14 lines each (~140) | A 64–128 KiB request cap | **Merge into one `jsonBody` helper** | ~125 |
| `handleRaw` × 19 + manual query validation | `conversation.ts:100-129`, `topics-http.ts`, others | Nothing the declared Schema wouldn't | **Switch to `handle`** | ~60 |
| 4 spellings of "commit the refusal" | `tokens.ts:86-91`, `lock-break.ts:45-55`, `passkey-management.ts:129/151`, `enrollment.ts:151`, `edit-lock.ts:162-165` | A real invariant: proof consumption and expiry sweep must commit even when the request is refused | **Keep the idea, export one `committed`** | ~30 and 5 lint suppressions |
| 5 canonical `*-schema.ts` files | `lock-break-schema.ts` 7, `enrollment-schema.ts` 39, `token-mint-schema.ts` 52, `refresh-schema.ts` 52, `passkey-management-schema.ts` 56 (206) | Partially breaks 5 `auth.ts` import cycles — and fails, the cycles still exist | **Merge into their feature files**, invert injection to a `Verifier` service | ~50, removes 5 cycles |
| 3 DDL `*-schema.ts` files | `cutover-schema.ts` 9, `auth-schema.ts` 18, `backup-metadata.ts` 19 (46) | Real migration steps, assembled by `boot-schema.ts` | **Keep, rename** to `NNN-name.ts` — they are migrations, not schemas | 0 |
| Two migration systems | `kernel/database.ts` 89 + `kernel/migrations.ts` 51, `migrations/` empty | Inline ladder protects v1→v6 upgrade; `Migrator` protects app-authored migrations | **Merge** the ladder into files the `Migrator` loads | ~40, high risk |
| `database.ts:74-86` shape probes | 17 lines | Real: catches a hand-edited or half-migrated DB before writes | **Keep**, collapse to a table→columns loop | ~8 |
| `events.query` double filter | `events.ts:196-211` (16) | Nothing — SQL at `:184-191` already filters | **Delete the JS copy** | ~16 |
| `Outcome<A>` | `edit-lock.ts:67-70` (4) | Real: separates durable state change from not-yet-published transitions. `edit-lock.ts:349` states the store "never claims event delivery" | **Keep**, rename (see naming) | 0 |
| `Transition` | `edit-lock.ts:17-36` (20) | Real: the audit event a caller must publish after commit | **Keep** | 0 |
| `Receipt` (refresh) | `refresh-receipt.ts` 78 + `refresh-schema.ts` | Real: lets a retried refresh return the identical pair. SPEC's "no lost acknowledged writes" | **Keep** | 0 |
| `closureUnproven` / `assertClosure` | `supervisor.ts:50-53`, `:138` | Real and load-bearing: prevents two DB writers | **Keep** | 0 |
| 4 null-`Ref` service holders | `index.ts:32-35`, `server.ts:62-65` | Nothing — works around layer ordering | **Delete**, fix the layer graph | ~40 across call sites |
| `cutover.ts` mutable flags + IIFEs + 3 dies | `cutover.ts:105-110`, `:191/199/210`, `:226/232` | Nothing | **Restructure `perform`'s return** | ~15 |
| `optionsSource` alias | `cutover.ts:296` | Nothing — shadowing workaround | **Rename the parameter** | 1 |
| `HealthProbe` ambient service | `health-probe.ts` 17 + 4 `serviceOption` sites | Lets a health probe run a real write without publishing | **Merge into an explicit mode argument** | ~15, medium risk |
| `extension-api.ts` `Api` | 56 lines, 4 members | The extension contract | **Keep** — 4 members vs pi's 62; this is the opposite of over-abstracted | 0 |
| `extension-work.ts` `work()` | 34 lines | Real: normalizes `Effect`/`Promise`/value from untrusted extension code | **Keep** | 0 |
| `published-topics.ts` / `published-messages.ts` | 9 + 15 | Real: the fence-respecting read. 3 importers each | **Keep** | 0 |
| `extension-page/-cron/-discovery.ts` | 22 + 19 + 53, 1 importer each (`ext.ts`) | Nothing, but `ext.ts` is already 442 lines | **Keep** — splitting is correct here | 0 |

**Total comfortably achievable: ~370 lines**, of which ~250 carry near-zero risk.

### Naming: real invariant or jargon?

| Term | Verdict |
|---|---|
| **admission / admit** | **Worst problem in the codebase.** Three unrelated meanings: `supervisor.admit` (`supervisor.ts:123`) registers an attempt in a list; `traffic.admit` (`traffic.ts`) waits on the freeze gate and returns a destination; `edit-lock.admit` (`edit-lock.ts:131`) runs an action inside a transaction with expiry cleanup. Rename to `recordAttempt`, `awaitDestination`, `withLockTransaction`. |
| **receipt** | Two meanings: an encrypted refresh blob (`refresh-receipt.ts`) and a file proving a child closed (`child-keeper.ts:45-51`). Both real; the shared word is not. |
| **keeper** | Real. `child-keeper.ts` exists because a parent pipe's EOF kills a hung child. `child-owner` would be plainer but the concept is load-bearing. |
| **closure** | Real and the sharpest-named thing here. `closureUnproven` means "a prior DB owner may still be alive". Keep. |
| **publication / published_through** | Real. Distinguishes a committed row from a durably published event. SPEC depends on it. |
| **fence** | Real, and standard distributed-systems vocabulary. Keep. |
| **materialize** | Real — copies the tree to a temp dir with the proposal applied (`source-files.ts:286-302`). `buildProposalTree` would be plainer. |
| **proposal** | Real. A prepared, identified, not-yet-published change set. Keep. |
| **transition** | Real. An event owed to the caller after commit. Keep. |
| **Outcome\<A\>** | Real invariant, vague name. `WithTransitions<A>` says what it is. |

### Configuration with a single value ever passed

- `work(run, drainPromise = false, onSuccess = Effect.void)` (`extension-work.ts:10-13`) — three params, and the 2nd and 3rd are defaults at most call sites.
- `supervisor.launch(generation, filename, mode, rehearsalSequence?, epochOverride?)` (`supervisor.ts:84-89`) — the last two are passed together from exactly one site, `cutover.ts:136-137`.
- `stageBatch(owner, writes, { requireEmpty })` (`edit-lock.ts:168-172`) — `requireEmpty: true` is passed from exactly one site, `source-files.ts:217`.
- `activate(value, state = "live")` (`supervisor.ts:139`) — the non-default `"accepted"` comes only from `cutover.ts:205`.

None of these is worth a refactor on its own; they are listed for completeness.

---

## The "feel" comparison

For an agent editing under time pressure, the two codebases fail in opposite directions. pi's risk is **volume**: to change one thing in `interactive-mode.ts` you must hold 6620 lines in your head, and its own `AGENTS.md` tells you to read files in full. But the path from a CLI flag to the work is six named hops, every identifier is a plain verb on a domain noun, values are passed bare, and `undefined` means "no change". An agent who finds the right file can usually finish the edit in that file.

comms is the inverse: no file is long, the directories are flat, and each file is genuinely about one thing — that part of tech.md landed. The cost is that the *semantics* are distributed. To change how a message write is rejected you must reason about `KernelError` (untyped string code), `failure()`'s nested-ternary status map, the `acquireUseRelease` mutation gate in `server.ts`, the lifecycle state machine, and the `published_through` fence — five files, none of which names the others. The vocabulary compounds this: `admit` means three different things, so an agent that greps for it gets three unrelated subsystems. And because `handleRaw` is universal, the declared HttpApi Schemas look authoritative and are not, which is the most dangerous kind of wrong: an agent that adds a field to `MessagePatch` will reasonably assume validation follows, and it will not.

Where comms is clearly better than pi: resource lifetimes are provably correct (`child-keeper.ts`), there is no module-level mutable state anywhere, and the durability invariants carry comments that cite *why* rather than narrating *what* — `edit-lock.ts:131`, `events.ts:92`, `supervisor.ts:49`, `cutover.ts:246`. Those comments are the single thing most likely to stop an agent from breaking a spec guarantee, and pi has no equivalent.

The honest summary: comms is not broadly over-abstracted. Its kernel is well factored, most modules have 2-4 importers, and the ceremonial-sounding names mostly do label real invariants. Its problem is **under-typed plumbing at the boundaries**, plus one architectural knot — `auth.ts` as a 5-cycle hub whose constructor-closure injection spawned five `*-schema.ts` files that do not even break the cycles they exist for.

## Five simplifications, ranked by lines-saved to risk

None of these touch durable cutover, the edit lock, acknowledged-write durability, or the passkeys-only rule.

1. **Extract one `jsonBody(schema, limit)` helper and delete 10 copies.** ~125 lines, purely mechanical, fully covered by the existing 71 test files. Pure win.
2. **Type the five error `code` fields as `Schema.Literals`, then replace `failure()`'s ternary with a `Record<code, status>`.** ~25 lines, but the real payoff is that a code without a status mapping becomes a compile error instead of a silent 503 `retriable: true`. Touches no durability logic — only how an already-decided failure is rendered.
3. **Collapse `boot/src/index.ts`'s three `Effect.provide` tiers into one layer graph and delete the four null-`Ref` holders.** ~40 lines and the single biggest readability gain in the repo. Moderate risk, but well fenced: `kernel-boot.test.ts`, `proxy.test.ts` and the recovery tests exercise exactly this startup ordering, and the `boot_unavailable` 503 behaviour is directly asserted.
4. **Export one `committed` helper and delete the other four spellings; delete `events.query`'s duplicate JS filter; rename `cutover.ts`'s `optionsSource` and remove the mutable flags, 3 `Effect.die`s and 2 IIFE casts.** ~60 lines across three independent, individually revertable edits. The `committed` consolidation actually *hardens* the invariant by putting it in one reviewable place.
5. **Disambiguate `admit`** into `recordAttempt` / `awaitDestination` / `withLockTransaction`. Zero lines saved, zero behavioural risk, and the highest return per minute of any item here for a future agent's ability to grep.

Deliberately **not** ranked: merging the two migration systems (touches durable schema), and removing `HealthProbe` (changes what a health probe commits). Both are real problems; neither is worth the risk against these guarantees right now.
