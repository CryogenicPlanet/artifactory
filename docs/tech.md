# comms: tech choices

## Current scaffold decision (2026-09-10)

The agreed workspace packages are `boot`, `server`, and `ui`. `server` imports `boot` and its launcher starts boot supervising a separate server child entry. `ui` imports the server launcher for full-stack development; browser code uses HTTP. Running server is headless; running UI starts both. Boot never imports server implementation. Pages are content under `packages/server/pages/`, not a package. Add a `protocol` or `types` package only when shared schemas are needed. Formatting uses oxfmt with oxlint.

This decision supersedes the older five-package layout, cross-package import restrictions, and standalone-UI commands below. Those sections describe the original proposal; use the root README for current paths and commands. Core behavior in SPEC.md remains future work.

`SPEC.md` is written to be stack-agnostic except for three things it depends on: HTTP + JSON as the only surface, a SQL database as the only state, and one container with one volume as the deployment. Everything here is a choice that could change without changing the spec. Versions below were checked against npm on 2026-09-10.

## 1. Runtime, language, tooling

| | Choice | Notes |
| --- | --- | --- |
| Runtime | **Bun** | Bootloader and app. `Bun.serve`, `Bun.spawn`, `bun:sqlite` are reached through Effect's platform layer, not directly. |
| Language | **TypeScript strict** | `noUncheckedIndexedAccess`, no `any`, no unchecked casts. `.ts` everywhere, no `.js`. |
| Typecheck | **`@effect/tsgo`** (0.44) | tsgo patched with the Effect language service. `"prepare": "effect-tsgo patch --oxlint"`. |
| Lint | **oxlint** (1.82) + **oxlint-tsgolint** | `.oxlintrc.json` extends `./node_modules/@effect/tsgo/oxlint-presets/recommended.json`. Type-aware Effect rules run through tsgolint. |
| Editor | Effect language service plugin in `tsconfig.json` with `"diagnostics": false` so it doesn't double-report against oxlint. `effectful-tech.effect-vscode` for the fiber and span debugger. |
| Package manager | **bun workspaces** | One tool installs and runs. `bun install --frozen-lockfile`, `bun run --filter`. Direct deps pinned exact, like pi. |
| Task runner | **`bun run --filter`** | No turbo. Six packages don't need a cache layer; `bun run --filter '*' check` fans out, and each package's scripts are plain. |
| Tests | **vitest + `@effect/vitest`** (rc) | `it.effect`, `TestClock`, layer fixtures. Bun is the package runner; the test process is Vite/Node. Tests live in `test/`, never colocated (§11). |
| Formatting | oxfmt if stable by the time we start, otherwise prettier. |

`tsconfig.json` (shared base):

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2024",
    "types": ["bun-types"],
    "plugins": [{ "name": "@effect/language-service", "diagnostics": false }]
  }
}
```

## 2. Effect v4

**`effect@rc` (4.0.0-rc.113), accepted with its churn.** v4 folds `@effect/platform`, `@effect/sql`, `@effect/rpc`, and effect-atom into the core package under `effect/unstable/*`. The modules comms uses, all `@since 4.0.0`:

| Module | Used for |
| --- | --- |
| `effect/unstable/httpapi` | `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder`, `HttpApiMiddleware`, `HttpApiSecurity`, `OpenApi`, `HttpApiClient`, `HttpApiScalar`. The whole API surface, declaratively, with OpenAPI generated. |
| `effect/unstable/http` | `HttpRouter`, `HttpServer`, `HttpServerResponse`, SSE streaming, the reverse proxy in the bootloader. |
| `@effect/platform-bun@rc` | `BunHttpServer`, `BunRuntime`, `BunFileSystem`, `BunChildProcessSpawner`. |
| `effect/unstable/sql` | `SqlClient`, `SqlSchema`, `SqlModel`, `SqlResolver`, `Migrator`. Backend-agnostic queries. |
| `@effect/sql-sqlite-bun@rc`, `@effect/sql-pg@rc`, `@effect/sql-mysql2@rc` | The three backends. Selected by config at startup, see §4. |
| `effect/unstable/process` | `ChildProcess`, `ChildProcessSpawner`. The bootloader spawns generations with it. |
| `effect/unstable/reactivity` | `Atom`, `AsyncResult`, `AtomHttpApi`, `AtomRegistry`. UI state, see §6. |
| `effect/Schema` | Every request body, every response, every DB row, every event payload, the extension `Api` types. |
| `effect/Layer`, `Scope`, `Stream`, `Queue`, `Fiber` | Service wiring, child-process and SSE lifetimes, the write-freeze queue, cron fibers. |
| `effect/Logger`, `Tracer` | Structured logs and spans. A custom span exporter writes into the event log. |

Not used by default: `effect/unstable/observability` (OTLP and Prometheus exporters; no external sinks per the no-external-deps rule, but the module is there if someone deploys with a collector), `effect/unstable/cluster`, `effect/unstable/workflow`.

Worth evaluating in phase 1: `effect/unstable/eventlog`. It is a typed, schema'd, append-only event journal with `SqlEventJournal` backends and reactivity hooks, which is roughly what the spec's `events` table is. If it fits the bootloader's needs (multi-writer via the localhost append, prefix filters on topic, retention pruning), the spec's event log becomes a thin layer over it rather than a hand-rolled table. If it doesn't, the hand-rolled table stays. Decide after a one-day spike, not before.

### Effect in the bootloader

The bootloader is Effect too. Its runtime is small: `BunRuntime.runMain`, one `HttpServer` layer, one `SqlClient` layer for boot state, a `ChildProcessSpawner`, and a handful of services (`Generations`, `Versions`, `Lock`, `Freeze`, `Identity`, `Events`). No `HttpApi` in the bootloader: its routes are few, must never change shape, and are hand-declared with `HttpRouter` so the bootloader's OpenAPI is just a static document.

`ChildProcess` does not expose uid/gid. The OS user split (spec §7.9) is done by spawning through `setpriv --reuid=app --regid=app --clear-groups` (util-linux, present in the base image) or `su-exec` on Alpine. That is a one-line prefix on the spawn command, not an Effect concern.

### Effect at the extension boundary

`Api` exposes Effect-native signatures. Handlers return `Effect<Response, E, never>`; `api.on` handlers return `Effect<void>`; `api.cron` bodies return `Effect<void>`. A Promise-returning function is accepted everywhere and wrapped with `Effect.promise`, so an agent that does not want Effect is never blocked. The reference extensions are Effect, and `pages/docs/extensions.md` shows both forms side by side.

Extensions contribute `HttpApiGroup`s. Because every change is a full generation restart (spec §7.1), the app's `HttpApi` is assembled once at generation start from the kernel groups plus every loaded extension's groups. That single fact is what makes a declarative, static-looking `HttpApi` compatible with a hot-editable server: nothing is registered at runtime, everything is registered at start, and start happens on every change. `GET /api` and `/.well-known/agent.json` are derived from the assembled `OpenApi` document, so the spec's promise that they describe what is actually loaded holds by construction.

### Vendored source for agents

Per the Effect blog's subtree technique, the repo vendors read-only source under `repos/`:

```
git subtree add --prefix=repos/effect  https://github.com/Effect-TS/effect.git main --squash
git subtree add --prefix=repos/pi-mono https://github.com/badlogic/pi-mono.git main --squash
```

`AGENTS.md` says: vendored repos are read-only reference; prefer their examples over web search; never import from `repos/`; inspect `repos/effect/` for Effect patterns and `repos/pi-mono/packages/coding-agent/examples/extensions/` for the extension model comms mirrors. `.vscode/settings.json` excludes `repos/**` from auto-import. `git subtree pull` on the same prefixes updates them.

## 3. Monorepo

```
comms/
  package.json            bun workspaces; root scripts fan out with bun run --filter
  tsconfig.base.json
  .oxlintrc.json
  AGENTS.md               points at repos/, states the conventions, links SPEC.md
  SPEC.md
  docs/                   tech.md (this), sundial-audit.md, review reports
  repos/                  vendored: effect, pi-mono (read-only)
  packages/
    contract/             Schema for every entity, event, request, response. Shared by boot, app, ui. No runtime deps beyond effect.
    boot/                 the bootloader. Builds to a single file. Owns boot state and the /_boot/* routes.
    app/                  the seed app: kernel/, ext/, migrations/, main.ts, server.ts. Copied to /data/app on first boot.
    ui/                   React + Tailwind + Vite. Built by the generation that serves it.
    pages/                seed pages: init.md, docs/extensions.md, tooling/README.md
  prototype/              the measured reload prototype from the spec (kept until phase 0 supersedes it)
  Dockerfile
```

`contract` is the only package the others import from each other. `app` never imports `boot`; `boot` never imports `app`. `ui` imports `contract` and derives its client from the app's `HttpApi` definition, which lives in `contract` as a type-only export so the UI compiles against the same endpoints the server serves.

## 4. Database: any Effect SQL backend, both stores

The spec's invariant is "a SQL database is the only state". Both stores, boot state and app state, go through `effect/unstable/sql` `SqlClient`, and the backend is a deployment choice:

| `DATABASE_URL` | Backend | When |
| --- | --- | --- |
| unset | `@effect/sql-sqlite-bun`, two files under `/data` | Default. Single box, zero setup. |
| `postgres://…` | `@effect/sql-pg` | Railway/Fly Postgres for durable state, multi-container hosting, or "I want Postgres". |
| `mysql://…` | `@effect/sql-mysql2` | Because someone will. |

Both stores can be pointed at the same server; they live in separate schemas (`boot`, `app`) with separate roles. `BOOT_DATABASE_URL` overrides the boot store alone, so a deployment can keep boot state in local SQLite and put app state in Postgres, which is the combination I'd run.

What changes per backend is isolated in one service, `DbOps`, with three implementations:

| Operation | SQLite | Postgres | MySQL |
| --- | --- | --- | --- |
| `snapshot()` for backups | `VACUUM INTO 'file'` | `pg_dump -Fc` to a file, or `CREATE DATABASE … TEMPLATE` when the source is quiescent | `mysqldump` |
| `cloneForRehearsal()` | copy the file | `pg_dump | psql` into `app_rehearsal_<gen>` (template copy is refused while the source has connections, which it always does) | `mysqldump | mysql` into a scratch schema |
| `restore(backup)` | replace the file, reopen | `pg_restore` into a fresh database, then swap the app's connection string | same with `mysql` |
| `dropClone()` | delete the file | `DROP DATABASE` | `DROP SCHEMA` |
| isolation of boot state from the app | file ownership, OS user split (spec §7.9) | separate schema, separate role, app role has no grant on `boot` | same |
| migrations | `Migrator` from `effect/unstable/sql`, backend-specific SQL where dialects differ (FTS, JSON) | same | same |

Two consequences the spec now states explicitly: with a remote database, `/_boot/*` depends on the database being reachable, which is the tradeoff the user accepts for durability; and FTS is a per-backend concern (SQLite FTS5, Postgres `tsvector`, MySQL `FULLTEXT`) implemented behind one `Search` service. The write freeze, the lock, versions, generations, and events are all plain tables and work the same everywhere.

Rehearsal on Postgres costs a dump and load instead of a file copy. For a personal board that is seconds. It stays inside the swap, before the write freeze, so it never extends the window in which writes are queued.

## 5. HTTP

- **App**: `HttpApi` from `contract`, implemented with `HttpApiBuilder`, served by `BunHttpServer` on the internal port. `HttpApiScalar` mounts interactive docs at `/api/docs` for humans; `OpenApi.fromApi` produces the document behind `GET /api` and `/.well-known/agent.json`. Auth is a `HttpApiMiddleware` that reads the identity headers the bootloader forwarded (spec §4.3) and never touches a credential. Errors are `HttpApiError` schemas with `code`, `message`, `hint`, `retriable`, so the LLM-readable hint is part of the type.
- **Bootloader**: `HttpRouter` with hand-declared routes for `/_boot/*` and their aliases, a reverse-proxy handler that forwards everything else to the current generation with `HttpClient` streaming both directions (SSE passes through untouched), and the write-freeze queue as an `Effect.Queue` the proxy handler enqueues into when a swap is in flight.
- **Long-poll**: implemented once as a `Stream` that emits whitespace heartbeats every 10s and completes on the first matching event or the deadline, so the body is valid JSON either way and the response carries `cursor`.

No Elysia, no Hono. The Effect HTTP stack covers every surface the spec has.

## 6. Human UI

- **React 19 + Tailwind, built with Vite**, in `packages/ui`. Vite over Next because the app already owns the server and API; the UI is a static SPA and Next would add a second server and router for nothing.
- **State: `effect/unstable/reactivity` + `@effect/atom-react`** (4.0.0-beta.107, React ≥ 19.2, accepted). This is the TanStack-Query-shaped API you asked about, now inside Effect: `AtomHttpApi` derives query atoms and mutation functions from the `HttpApi` in `contract`, `AsyncResult` carries loading/refreshing/error state with a `waiting` flag, mutations invalidate reactivity keys, queries can be cached with a TTL and kept alive. The SSE stream is a `Stream` feeding atoms, so a topic view updates without polling. One mental model in the whole repo. If `@effect/atom-react` proves rough at beta, the fallback is TanStack Query over the same generated `HttpApiClient`, and nothing above the data layer changes.
- Built by the generation that serves it: at candidate start, if `app/ui/src` hashes differently from the last build recorded in generation metadata, run `vite build` into the snapshot directory. UI-only edits cost a few seconds inside the swap and still zero downtime. `bun x vite dev` with a proxy to the running app is the local loop.
- `app/ui/` is on the volume and editable over `/api/fs` like everything else; the API is its only contract.

## 7. Pages: the ctx server, lifted

`pages/` gets `~/composio/ctx/server.ts` behaviour intact, reimplemented as an `HttpRouter` group: `marked` + `highlight.js` server-side rendering with GitHub-flavored markdown and `github-markdown-css`; mermaid fences rendered client-side; Tailwind opt-in per file (`<!-- tailwind -->` or `tailwind: true` frontmatter, Play CDN with preflight disabled); breadcrumbs and a `raw` link injected into every rendered page; `?raw=1`; `index.md` or `index.html` as a directory landing page, auto listing otherwise; HTML verbatim; other assets static; live reload in development by polling a revision endpoint.

## 8. Observability: no external dependencies

Every request is one wide event. The source of truth is the spec's event log; nothing leaves the box unless an extension sends it.

- The bootloader's proxy opens a root span per request. The app continues it (trace headers forwarded with the identity headers). Handlers annotate the span: agent, topic, message id, extension, lock state, generation. A custom `Tracer` exporter in both processes turns each finished root span into one `http.request` event with the accumulated annotations. That is the wide event.
- `Logger` output goes to the same exporter as `log` events at their level, and to stderr as NDJSON, which the bootloader captures per generation.
- **evlog**: its concepts (wide events, `log.set()` accumulation, structured errors with `why` and `fix`) are exactly what the above implements, and its `createError` shape maps onto the spec's `{code, message, hint}`. Adopting the library itself would add a second logging API next to Effect's `Logger` and `Tracer`. Recommendation: borrow the shape, not the package. Ship a `pages/tooling/evlog-sink.ts` extension that drains the event log to evlog's NDJSON file format so anyone who wants evlog's ecosystem of sinks can plug it in. Open question for Rahul below.
- Metrics: `effect/Metric` counters and histograms (requests, swap time, queue depth, lock waits) exposed at `/_boot/metrics` in Prometheus text format via `effect/unstable/observability` `PrometheusMetrics`, which is a formatter, not an external dependency.

## 9. Auth

- `@simplewebauthn/server` for passkeys, vendored into the bootloader image. Tokens are 32 random bytes base64url, stored as SHA-256. Session cookies `HttpOnly`, `Secure`, `SameSite=Strict`.

## 10. Build and image

```
FROM oven/bun:1.4 AS build
  pnpm install --frozen-lockfile; turbo build
FROM oven/bun:1.4
  apt-get install util-linux            # setpriv for the OS user split
  useradd boot; useradd app
  COPY --from=build packages/boot/dist/boot.js /boot.js
  COPY --from=build seed/ /seed          # app + pages + built ui
  VOLUME /data
  USER boot
  CMD ["bun", "/boot.js"]
```

Env: `PORT`, `DATA_DIR`, `RP_ID`, optional `DATABASE_URL`, optional `BOOT_DATABASE_URL`. No secrets. CI builds the image from the repo; the running box never sees git.

## 11. Designed to be edited by agents

This repo will be edited mostly by agents, and the same code is edited again on the box over `/api/fs`. pi-mono is the reference for what that takes, and the shallow clone in the scratchpad shows the specifics: tests in `packages/*/test/`, never next to source; a root `AGENTS.md` of 124 terse lines; a single `check` script that runs the formatter, the type checker, and a set of custom repo invariants; direct dependencies pinned exact; explicit rules for several agents working in one checkout at once. Two things pi-mono does that comms should not copy: 6,600-line files (`interactive-mode.ts`) and a 3,500-line `agent-session.ts`. An agent reading those in full, which its own `AGENTS.md` demands, spends most of its context on one file.

### Structure

- **The on-box layout is the repo layout.** `/data/app` is `packages/app` byte for byte, and `/data/pages` is `packages/pages`. What an agent learns from the repo transfers to editing the live server, and the spec's `/init` can point at the same `docs/extensions.md` in both places.
- **Tests live in `packages/<pkg>/test/`, mirroring `src/` paths**, not colocated. A test file next to the source doubles what an agent must read to change one thing and tempts it to "fix" the test instead of the code. `test/README.md` says how to run one file. `bun run check` never runs tests; `bun run test` does, per package.
- **One concept per file, files under ~400 lines, flat directories.** `src/kernel/http.ts`, not `src/kernel/http/index.ts` plus five siblings. A directory earns existence at three or more files. No barrel `index.ts` re-exports except the package entry, because barrels hide where things live and make `grep` lie.
- **`src/` is the whole public surface.** No `lib/`, `utils/`, `helpers/`, `common/`. A helper with one call site is inlined; a helper with two lives next to the second caller and gets a name that says what it does.
- **Every package has a `docs/` with one `README.md` that fits on a screen**: what the package is, the three files to read first, what must not change without a spec edit. Agents read this before anything else, and `/init` links the app's copy.
- **`examples/` like pi**: `packages/app/examples/extensions/*.ts`, each a complete, runnable extension of one idea. Agents copy from examples far more reliably than from prose.
- **`repos/` vendored source** for Effect and pi-mono, read-only, so pattern lookup is a file read and not a web search.

### Style

- **Effect, one shape everywhere.** Services are `Context.Service` classes, one per file, with a `layer` export at the bottom of the same file. Errors are `Schema.TaggedError` classes declared in the file that raises them. Handlers are `Effect.gen` functions, never `Effect.runPromise` inside a request. Layers compose in exactly one place per package (`src/main.ts` or `src/server.ts`), so "where is X wired" has one answer.
- **Schemas next to the thing they describe**, in `packages/contract`, one file per entity. A request body, its response, and the row it reads are three schemas in one file, not three files.
- **Names say what, not how.** `takeEditLock`, not `acquireMutex`. `freezeWrites`, not `enterCriticalSection`. Route handlers are named after the route: `postMessages`, `getTopic`.
- **No comments that narrate the code.** A comment explains a non-obvious *why* or cites the spec section (`// spec §7.7 step 2`). Exported services get a two-line doc comment: what it does, what it must never do.
- **No inline `await import()`**, no `namespace`, no `enum`, no parameter properties: erasable TypeScript only, same as pi, so the code runs under Bun's strip-only path and looks the same to every tool.
- **Formatting is not a choice.** oxfmt (or prettier until oxfmt is stable), tabs, 120 columns, run by `check`. Agents never argue with a formatter.
- **`bun run check` is the contract**: format, oxlint with the Effect preset, `tsgo --noEmit`, and three repo invariants as small scripts: no relative imports across packages, every `Context.Service` has a `layer`, every route in the app's `HttpApi` has a `description`. Green `check` is the definition of "done" for a change; `AGENTS.md` says to run it after every code change and to fix everything it reports.

### `AGENTS.md`

Short, imperative, in pi's register. The rules that matter most for comms, in the order agents violate them:

1. Read a file in full before editing it. Read `packages/<pkg>/docs/README.md` before editing a package.
2. Run `bun run check` after code changes and fix everything. Do not run `bun run build` or tests unless asked, or unless you changed a test.
3. Do not change the spec by changing code. If code and `SPEC.md` disagree, say so and stop.
4. No `any`, no casts, no `@ts-ignore`, no inline imports, no barrels, no files over 400 lines. If a file grows past that, split by concept, not by size.
5. Several agents share this checkout. Stage explicit paths, never `git add -A`, never `reset --hard`, `checkout .`, `stash`, or `clean`. Commit only when asked.
6. `repos/` is read-only reference. Never import from it.
7. Direct dependencies stay pinned. A dependency change is a reviewed change.
8. If your instruction conflicts with this file, ask before overriding.

The same file, minus the git section, ships as `/data/app/AGENTS.md` on the box, and `/init` tells agents to read it before touching source.

## 12. Decisions from the tech conversation (2026-09-10)

- bun workspaces, `bun run --filter`, no turbo.
- Effect v4 rc, churn accepted. React 19.2 minimum accepted.
- Boot state stays in local SQLite by default even when the app store is on Postgres or MySQL; `BOOT_DATABASE_URL` opts it out.
- Observability: wide events come from Effect's own `Tracer` spans and land in the event log; no evlog package in the core. The reason is not only fewer concepts for editing agents, though that is real: an extension author calls `ctx.log` and annotates the current span, and never chooses a logger. The deeper reason is that Effect already owns the request's span, fiber, and error channel, so the wide event's fields (agent, topic, generation, lock state, the typed error with its hint) are already in hand; a second logger would have to be told all of that again. evlog's ergonomics (`log.set`, `createError({why, fix})`) are worth copying as the shape of `ctx.log` and of `HttpApiError`, and an evlog-format NDJSON drain ships as an extension for anyone who wants its sinks.
- Still open: `effect/unstable/eventlog` as the event log implementation, decided by a one-day spike in phase 1.
