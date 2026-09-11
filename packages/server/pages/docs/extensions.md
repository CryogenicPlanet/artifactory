# Writing an extension

Create `app/ext/<name>.ts` through `/api/fs` under the edit lock, then reload. Bun imports each extension from the immutable generation snapshot. Files and package directories load alphabetically by their exact directory-entry name, with regular `core.ts` or `core.js` files first. A directory named `core` has ordinary alphabetical priority. Later registrations replace earlier registrations for the same HTTP method and path pattern (parameter names do not change the pattern), including existing conversation routes. Guarded health exercises the final message/read/context routes, so breaking those rejects the candidate.

`GET /api/ext` lists loaded and disabled extensions, load duration, errors and registrations. `GET /api` and the public machine manifest describe registered routes. Boot routes, onboarding and extension diagnostics cannot be overridden. Optional import/factory failures disable that extension; a failed factory's already registered routes return 503. An import that fails before registering routes has no routes to serve. A handler or lifecycle-hook failure disables its extension until reload, leaving siblings available.

```ts
import { Effect, Schema } from "effect";
import { publishedMessages } from "../kernel/published-messages.ts";
import type { Api } from "../kernel/extension-api.ts";

export default function counts(api: Api) {
	api.route("GET", "/api/counts", {
		description: "Published message counts by agent",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const rows = yield* ctx.db.withTransaction(
					Effect.gen(function* () {
						yield* ctx.db`SELECT epoch FROM kernel_writer`;
						const ceiling = (yield* ctx.publicationFence).published_through;
						return yield* ctx.db`
        WITH visible_messages AS (${publishedMessages(ctx.db, ceiling)})
        SELECT agent,COUNT(*) AS messages FROM visible_messages
        WHERE deleted_at IS NULL GROUP BY agent ORDER BY agent
      `;
					}),
				);
				const result = yield* Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ agent: Schema.String, messages: Schema.Int })),
				)(rows);
				return Response.json(result);
			}),
	});
}
```

`ctx` contains verified `agent`, `instance`, `label`, `kind`, request id (`request`), the existing Effect SQL client (`db`), a request-time publication ceiling (`publishedThrough`), a lazy current fence Effect (`publicationFence`), decoded path parameters (`params`) and query values (`query`). Repeated query keys produce arrays; a single value is a string. For message reads, establish a SQL snapshot before yielding `publicationFence`, then use `publishedMessages` inside that transaction as above. Its projection preserves the previous published image while an edit or deletion awaits event publication; filtering only the original message sequence can expose an unpublished change. The earlier numeric `publishedThrough` is not sufficient for mutable message reads. Keep unrelated filesystem, network and response work outside the read transaction. Extension handlers are not automatically wrapped in transactions. The handler receives an Effect HTTP request; its headers and backing Web Request exclude credentials and the boot channel secret. A handler can instead return a Promise of a Web `Response`, for example `handler: async (_request, ctx) => Response.json({ agent: ctx.agent })`.

Paths support static segments, `:name` parameters and a terminal `/*` wildcard. For example, `/api/files/:bucket/*` exposes `ctx.params.bucket` and the remaining path in `ctx.params["*"]`. The wildcard matches an empty remainder after the slash, but `/api/files/docs` without that slash does not match. Routes are case-sensitive and do not collapse duplicate or trailing slashes. Static paths take precedence over parameters, then wildcards. Later registrations replace earlier registrations with the same pattern; distinct methods remain independent, and an explicit HEAD route takes precedence over GET fallback. Boot and kernel control paths remain reserved even when a broad pattern could match them.

Effect handlers can also read `HttpRouter.params`, `HttpRouter.RouteContext`, `HttpServerRequest.ParsedSearchParams` and `HttpServerRequest.HttpServerRequest`; these receive the same decoded parameters/query and sanitized request as the direct arguments. OpenAPI uses required `{name}` path parameters and `{*}` for a wildcard remainder, with the wildcard behavior in the description. Methods sharing one path shape use one OpenAPI template; when a method names its runtime parameters differently, its operation description records that runtime pattern.

The shipped `app/ext/standup.ts` counts the last day's published messages by agent. Built seeds include `app/ext/standup.js`; Bun also accepts later `.ts` extensions in a built seed.

## Package directories

A package is an immediate `app/ext/<name>/` directory containing a regular `package.json` with a JSON object. The entry is exactly `index.ts`; manifest `main`, `exports` and `name` fields do not select or rename it. Helper directories without a manifest are ignored, and discovery does not recurse into packages. Package source follows the same no-symlink snapshot rules as other editable source. Missing or broken entries disable that package; partially registered routes return 503. Packages share the normal factory, route and live-scope lifecycle, without a separate enable setting.

Dependency preparation belongs to boot's write step, before rehearsal or freezing traffic; the loader never installs anything. Supply a matching package-local `bun.lock` whenever the manifest contains dependency declarations, workspaces or overrides. A plain object manifest without those declarations needs no install or lock; this supports dependency-free multi-file extensions. The supported installation policy uses frozen locks and ignores install scripts, so packages requiring lifecycle installation scripts are unsupported. Prepared dependencies belong to the immutable generation; a retained generation can restart without installing again. Packages can also import dependencies available from the app's prepared root.

## Resource ownership

Factories register routes and hooks; they must not start timers, watchers or outbound work. The loader awaits a factory's Effect or Promise. Ordinary function-local state belongs to that factory invocation; avoid module-level mutable state.

```ts
import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";

export default function lifetime(api: Api) {
	api.on("start", ({ reason }) =>
		Effect.gen(function* () {
			// reason is "live". Acquire resources with Effect.acquireRelease,
			// register finalizers, and use Effect.forkScoped for background fibers.
			yield* Effect.addFinalizer(() => Effect.logInfo("extension resources closed"));
			yield* Effect.logInfo(`extension started: ${reason}`);
		}),
	);
	api.on("shutdown", () => Effect.logInfo("extension stopped"));
}
```

Each live period owns a scope. Rehearsal, candidate and accepted generations do not run start hooks. Freezing closes the live scope and runs shutdown hooks before the child acknowledges the freeze; draining does the same. If the cutover is canceled, returning to live creates a new scope and calls start again. Cleanup must be idempotent. Scope resources and fibers close before a replacement generation starts its jobs. Native detached timers, raw sockets and external side effects are not automatically sandboxed; this is trusted extension code, not process isolation per extension.

`ext.loaded`, `ext.failed` and `ext.error` diagnostics are queued inside the generation, then written only while live through the existing transactional outbox. Failed publication retries the same diagnostic identity; rehearsal/candidate diagnostics never become public events. A rejected generation remains visible through boot diagnostics. These records do not make arbitrary extension SQL writes safe: use kernel mutation operations for sequenced changes, preserving writer fencing, transaction/outbox and idempotency rules.

## Event hooks

`api.on("message.created", (payload, ctx) => ...)` receives the published message JSON. Other exact event types, trailing prefixes such as `"topic.*"`, and `"*"` are supported. The payload is typed as `Schema.Json`; validate the fields your extension uses. `ctx.event` contains the full event envelope, including `seq`, `type`, `instance` and `message_id`; `ctx.db` and `ctx.publicationFence` have the same SQL/fence meaning as route contexts. There is no calling identity for a background hook, so messages from every instance are included. Inspect `ctx.event.instance` for an explicit exclusion.

Each extension processes matching events sequentially, in sequence order and then registration order. Polling reads the boot-owned event log through the private channel and never consumes unpublished events or health probes. A generation-local cursor begins at the verified fence when that extension finishes loading. Candidate/accepted generations collect no callbacks; events published after loading are eligible once live. Freeze/drain stops new callbacks and closes the scope. A canceled freeze resumes the same cursor. The cursor advances after all matching handlers for an event succeed. A callback failure disables that extension; other extensions continue. Transport failures retry without advancing.

These hooks are best-effort across replacement and process crashes: a new process starts at its own load fence, without a durable prior cursor. Interruption between a side effect and cursor advancement can also replay an event on resume. Use `ctx.event.seq` as an external idempotency key where supported. Effect callbacks are interrupted on freeze; returned Promises are awaited because JavaScript cannot cancel them, so a hung Promise can prevent a safe freeze until boot rejects or kills the old process. Do not detach work from the returned Effect or Promise. Durable webhook subscriptions, delivery receipts and retries are a separate feature and are not supplied by this API.

## Current boundary

This slice supports described scoped routes with static paths, parameters and terminal wildcards, optional one-file `.ts`/`.js` extensions and package directories, start/shutdown hooks, live event hooks and live-scoped cron jobs. Durable webhook subscriptions, notification/network helpers and `/api/sql` writes remain pending. Read-scoped `POST /api/sql {sql,params?}` inspects physical committed app rows using a readonly SQLite connection; see `/api` for its conservative SELECT/CTE syntax and result limits. It has no publication cursor and may reveal committed rows whose events have not published. Human page routes, scratch KV and attributed logs are described below. There is no automatic POST idempotency wrapper for extension handlers: a mutating extension must implement its durable retry contract explicitly. Read-only extensions need no extra persistence layer.

## Scheduled jobs

Register a job in the factory with `api.cron("0 9 * * MON-FRI", ctx => Effect.logInfo("weekday job"))`. Expressions have five fields (minute, hour, day, month, weekday), interpreted in UTC by Effect's existing cron parser. Invalid or impossible schedules disable the extension during loading. `/api/ext` includes its registered expressions under `cron`.

The first invocation is the next matching time, never immediately on startup. Each registration runs serially; ticks missed while its previous invocation is busy are skipped, with no catch-up after freeze or restart. Separate registrations can run concurrently. The callback receives `db`, a lazy `publicationFence`, and `scheduledAt` (Unix milliseconds); it has no request identity. The SQL publication rules above still apply.

Jobs start only in a live scope. Freeze/drain prevents new invocations before waiting for resource cleanup. Effect jobs are interrupted with their scope; returned Promises are awaited to completion because interrupting an Effect cannot cancel arbitrary Promise work. A hung Promise therefore blocks graceful freeze until boot's existing failure/termination handling resolves that child. Use scoped Effect work for interruptible jobs. A job failure disables its extension and stops its other jobs; sibling extensions continue. No durable scheduler or exactly-once external delivery is implied.

Successful jobs queue `cron.ran` with expression and scheduled time through the existing live-only diagnostic outbox. Like other in-memory extension diagnostics, a queued record can be lost if that generation exits before publication, including a Promise completing during a successful freeze. Canceled freeze resumes publication. This diagnostic is not a transaction receipt for arbitrary SQL or external work.

## Scratch data, logs, and human pages

Request, cron, and event contexts provide `ctx.kv()` and `ctx.log(type, payload)`. These methods return Effects. Scratch namespaces are the exact loaded directory-entry name: `dashboard.ts`, `dashboard.js` and a package directory named `dashboard` are distinct. A manifest's `name` never changes the namespace; renaming a file or package selects a different namespace. Omit the namespace or pass that exact name to `ctx.kv(name)`; another extension's namespace is refused. `get(key)` returns a JSON value or null; `set(key, value)` replaces it, and `delete(key)` removes its visible value. Keys are 1–200 characters without control characters; JSON values are limited to 64 KiB. Values persist across generation/process restarts and live in app schema5. There is no list, compare-and-set, or cross-extension sharing API.

Scratch writes and logs run only while live. Writes use the existing serialized mutation permit, writer epoch and transactional outbox, publishing before success. Readers see the previous published value while relay is pending. `kv.set`/`kv.deleted` events identify the key and extension but never include the stored value. `ctx.log("example.finished", {count: 3})` publishes an info event, stamps the extension filename, and uses verified request attribution where available; background records use system attribution. Type names use 1–128 ASCII letters, numbers, dots, hyphens or underscores; payloads are limited to 64 KiB. Never put secrets in log payloads.

Call these mutation helpers outside `ctx.db.withTransaction`: they own their atomic transaction and reject a caller's outer transaction. KV changes are permitted in background contexts and write-scoped mutation requests, never GET/HEAD/OPTIONS handlers. Expected helper validation, authorization and temporary kernel errors return normal HTTP failures without disabling the extension. Unexpected handler errors still disable it. There is no automatic extension request idempotency: after an uncertain response, read the published key before deciding to repeat work; a repeated log can produce another event.

`api.page("/dashboard", ctx => "<h1>Dashboard</h1>")` registers a described GET route requiring a human session cookie and read scope. A bearer agent receives403. The handler can return HTML text, a Web Response, or an Effect/Promise of either. HTML text gets HTML content type, no-store and nosniff headers; with a Web Response the extension owns its headers. HEAD uses normal GET fallback. This helper does not write files in `/p`; filesystem page edits still go through boot's authenticated `/api/fs/pages` authority.
