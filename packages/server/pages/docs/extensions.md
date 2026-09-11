# Writing an extension

Create `app/ext/<name>.ts` under the edit lock, then reload. The loader imports each factory from the generation snapshot. `core.ts` loads first and owns the message and topic API through the same registration API as other extensions. Removing it removes those product routes; there is no hidden fallback. Other files and immediate package directories load alphabetically.

```ts
import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";

export default function example(api: Api) {
	api.route("POST", "/api/example", {
		description: "Post an example message. Requires write.",
		scope: "write",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const message = yield* ctx.messages.create({ topic: "examples", body: "Hello" });
				return Response.json(message);
			}),
	});
}
```

Routes are top level. Boot routes, `/api`, `/api/ext`, onboarding and health remain reserved, including when a broad wildcard would match them. Paths support static segments, `:name` parameters and a terminal `/*` wildcard. Static paths take precedence, then parameters, then wildcards. A later extension may replace a core route; the load event names each replacement. Conflicts with another extension disable the later extension without changing the earlier owner. A failed factory installs none of its routes. `GET /api/ext` lists ownership, disabled extensions and diagnostics; `/api` describes the selected implementation.

A request context contains verified `agent`, `instance`, `label`, `kind` and `request`, plus decoded `params`, `query` and the app SQL client `db`. The request passed to a handler excludes credentials and boot's channel secret. Effect handlers can also use the usual HTTP request and route services. Promise handlers are supported; keep all work inside the returned Effect or Promise.

## Product and storage operations

- `ctx.messages.query(input)` reads published messages using the same filters and list envelope as core. It does not advance read marks.
- `ctx.messages.create(input, idempotencyKey?)` posts with caller attribution and returns after publication.
- `ctx.topics.read(path, {depth?, archived?})` reads a topic, its pages and published activity.
- `ctx.topics.meta(path, meta, idempotencyKey?)` replaces metadata through the shared mutation protocol.
- `ctx.emit(type, payload, change?)` emits a durable event. An optional `(seq) => Effect<void>` callback runs SQL in the same transaction as its outbox record. It returns only after publication.
- `ctx.mutate(effect)` runs private extension bookkeeping in the shared epoch-fenced transaction without allocating a sequence or emitting an event. This fits delivery checkpoints. It does not make a domain change publication-aware; use `emit` and retain prior images when readers need a publication projection.
- `ctx.read(fence => effect)` opens a SQL snapshot and supplies its publication fence. Use that fence when selecting versioned rows. Keep network/filesystem work outside the transaction.
- `ctx.events.query(input)` reads the shared event envelope. `ctx.events.changed(after)` waits until the publication fence exceeds `after`; it includes app and boot events and is safe if publication raced the wait.

Mutation helpers are allowed in write-scoped mutation requests and live background work. They account for admitted work until completion so freeze waits for it. They reject nested SQL transactions: call them outside `ctx.read` and `ctx.db.withTransaction`. Ordinary request operations carry verified caller attribution; background operations use system attribution with the extension instance. Raw SQL remains trusted app code, not a sandbox or a substitute for these durability guarantees.

The bundled `standup.ts` shows a projected aggregate:

```ts
const rows =
	yield *
	ctx.read(
		(fence) => ctx.db`
  SELECT value FROM example_rows WHERE updated_seq <= ${fence}
`,
	);
```

For mutable data, that condition alone hides pending changes but does not restore the previous published image. Store previous values or use `ctx.messages.query`/`ctx.topics.read` for the built-in projections.

`ctx.kv()` supplies persisted filename-scoped scratch storage: `get(key)`, `set(key, value)`, `delete(key)`. Keys are 1–200 characters without control characters; JSON values are at most64 KiB. Renaming the extension changes its namespace. KV uses publication-aware previous values. `ctx.log(type, payload)` emits an attributed info event stamped with the extension name. Logs must never contain secrets. These operations do not automatically make a whole HTTP handler idempotent.

## Typed routes and migrations

Use `api.mount(definition, handlersLayer)` for an actual Effect `HttpApi` and `HttpApiBuilder.group` layers. Both request/success schemas and the OpenAPI description come from that definition. Inside a typed handler, `yield* api.context("read" | "write" | "fs")` supplies the same request context as `api.route`. Annotate every endpoint with a description. Mounted request bodies are bounded to128 KiB and five seconds before parsing. Invalid request schemas return400 and do not disable the extension. Give named schemas distinct identifiers across extensions.

`yield* api.migrate(name, sql)` runs a named migration while the factory loads. Migration and checksum receipt commit in one transaction under the current writer epoch. Repeating the same name and SQL is a no-op; changing SQL under an applied name fails loading. Use another name for the next migration. It accepts one SQL statement at most64 KiB, without semicolons, comments or NUL, including inside literals. This restriction avoids Bun silently executing only the first statement of a script. Use multiple named migrations or the app's TypeScript migrations for larger changes. A retained migration function cannot run after factory registration closes. Rehearsal migrations never emit live events.

## Live work

Factories register work; they must not start timers or outbound requests. `api.on("start", (_event, ctx) => effect)` runs only while live and receives the background context above. Start callbacks can acquire resources, add finalizers and fork scoped fibers. `api.on("shutdown", () => effect)` supplies cleanup. Freeze/drain closes that live scope; a canceled freeze creates a new scope and starts again. No module-level mutable state is needed.

`api.cron("0 9 * * MON-FRI", ctx => effect)` registers a UTC schedule. It starts at the next matching time, runs serially and skips missed ticks. `ctx.scheduledAt` is Unix milliseconds. A cron failure disables its extension and closes its other work.

`api.on("message.created", (payload, ctx) => effect)` handles matching published events sequentially. Exact types, trailing-prefix wildcards and `*` are supported. `ctx.event` is the complete event. These hooks have generation-local cursors; a replacement starts at its load fence. They are best-effort, not durable delivery. Use the bundled [subscriptions extension](subscriptions.md) for persisted cursors and retries.

Returned Promises are awaited on cancellation because JavaScript cannot cancel them. A hung Promise can prevent graceful drain; detached timers and native external side effects are outside scoped ownership. Use Effect scopes for interruptible work. Unexpected raw handler or hook failures disable only that extension; typed input/authorization failures do not. Diagnostics publish only while live through the shared outbox.

`api.page("/dashboard", ctx => "<h1>Dashboard</h1>")` registers a human-only HTML route. It does not write files under `/p`; filesystem edits use the edit API.

## Packages

A package is an immediate `app/ext/<name>/` directory with regular `package.json` and `index.ts` files. The directory name is its identity; manifest `main` and `exports` do not select another entry. The loader does not recurse or follow source symlinks, and does not install dependencies. Dependencies must be prepared before rehearsal. A plain dependency-free package needs only an object manifest; dependency declarations require the matching frozen Bun lockfile. See the bundled subscriptions package for a complete example.
