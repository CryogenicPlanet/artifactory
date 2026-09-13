import { scopesHeader } from "@comms/protocol/headers";
import { assertNoPendingMigration } from "./migration-intent.ts";
import { encodeError, policy } from "@comms/protocol/errors";
import { makeExtensionEffects, type ExtensionEffects } from "./extension-effects.ts";
import { reserved, requestPath, pattern, templatePattern, validateRoute } from "./extension-routes.ts";
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Path, Ref, Schema, Scope, Semaphore } from "effect";
import { FetchHttpClient, FindMyWay, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { SqlClient } from "effect/unstable/sql";
import { document } from "../extension-http.ts";
import type { OpenApi } from "effect/unstable/httpapi";
import { mountApi } from "./extension-mount.ts";
import { makeExtensionMigrate } from "./extension-migrations.ts";
import type { CapabilityFactory } from "./extension-capabilities.ts";
import { ExtensionError, work, type Work } from "./extension-work.ts";
import { parseCron, runCron } from "./extension-cron.ts";
import { identity } from "../conversation-request.ts";
import { Publication } from "./publication.ts";
import { Lifecycle, type State } from "./lifecycle.ts";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { pageHandler } from "./extension-page.ts";
import { extensionData } from "./extension-data.ts";
import { runEvents } from "./extension-events.ts";
import { discoverExtensions } from "./extension-discovery.ts";
import type {
	Api,
	CronContext,
	EventHandler,
	Hook,
	RequestContext,
	RequestServices,
	ExtensionServices,
} from "./extension-api.ts";

interface CronJob {
	readonly expression: string;
	readonly schedule: ReturnType<typeof parseCron>;
	readonly handler: (context: CronContext) => Work<void>;
}
export interface Diagnostic {
	readonly transaction: string;
	readonly type: "ext.loaded" | "ext.failed" | "ext.error" | "cron.ran";
	readonly level: "info" | "error";
	readonly payload: Schema.JsonObject;
}
interface Registration {
	readonly extension: string;
	readonly method: HttpMethod;
	readonly path: `/${string}`;
	readonly description: string;
	readonly scope: "read" | "write" | "fs";
	readonly operation?: OpenApi.OpenAPISpecOperation;
	readonly handler: (
		request: HttpServerRequest.HttpServerRequest,
		context: RequestContext,
	) => Work<Response, RequestServices>;
}
interface Status {
	readonly name: string;
	readonly status: "loaded" | "disabled";
	readonly load_ms: number;
	readonly error: string | null;
}
const factory = Schema.Struct({
	default: Schema.declare<(api: Api) => Work<void> | void>(
		(value): value is (api: Api) => Work<void> | void => typeof value === "function",
	),
});

/** Owns one generation's optional extensions; resources exist only in a live scope. */
export class Extensions extends Context.Service<Extensions, Effect.Success<ReturnType<typeof make>>>()(
	"comms/server/Extensions",
) {}
const make = (directory: string, capabilities: CapabilityFactory, onWork: Effect.Effect<void>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const publication = yield* Publication;
		const boot = yield* BootChannel;
		const lifecycle = yield* Lifecycle;
		const data = yield* extensionData;
		const services = yield* Effect.context<ExtensionServices>();
		const documents: OpenApi.OpenAPISpec[] = [];
		const parentScope = yield* Scope.Scope;
		const transitions = yield* Semaphore.make(1);
		const diagnostics = yield* Ref.make<ReadonlyArray<Diagnostic>>([]);
		const statuses = yield* Ref.make<ReadonlyArray<Status>>([]);
		const registrations: Registration[] = [];
		const extensions: Array<{
			readonly name: string;
			readonly start: ReadonlyArray<(reason: "live" | "rehearsal") => Work<void> | void>;
			readonly effects: ExtensionEffects;
			readonly jobs: ReadonlyArray<CronJob>;
			readonly events: ReadonlyArray<{ readonly type: string; readonly handler: EventHandler }>;
			readonly cursor: Ref.Ref<number>;
			readonly shutdown: ReadonlyArray<Hook>;
			readonly scope: Ref.Ref<Scope.Closeable | null>;
		}> = [];
		const diagnostic = (
			name: string,
			type: Diagnostic["type"],
			error: string | null,
			details: {
				readonly expression?: string;
				readonly scheduled_at?: number;
				readonly overrides?: ReadonlyArray<string>;
			} = {},
		) =>
			Effect.gen(function* () {
				const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
				yield* Ref.update(diagnostics, (items) => [
					...items,
					{
						transaction,
						type,
						level: type === "ext.loaded" || type === "cron.ran" ? "info" : "error",
						payload: { extension: name, ...details, ...(error === null ? {} : { error }) },
					} satisfies Diagnostic,
				]);
				yield* onWork;
			});
		const failed = (name: string, cause: Cause.Cause<unknown>, type: "ext.failed" | "ext.error") =>
			Effect.gen(function* () {
				const error = Cause.pretty(cause).slice(-8192);
				yield* Ref.update(statuses, (items) =>
					items.map((item) => (item.name === name ? { ...item, status: "disabled", error } : item)),
				);
				yield* diagnostic(name, type, error);
			});
		yield* assertNoPendingMigration(sql);
		for (const entry of yield* discoverExtensions(directory)) {
			const { name } = entry;
			const pending: Registration[] = [];
			const pendingDocuments: OpenApi.OpenAPISpec[] = [];
			const mounts: Array<ReturnType<typeof work<void>>> = [];
			const migrate = yield* makeExtensionMigrate(sql, boot.epoch, name);
			const jobs: CronJob[] = [];
			const events: Array<{ readonly type: string; readonly handler: EventHandler }> = [];
			const activeScope = yield* Ref.make<Scope.Closeable | null>(null);
			const effects = yield* makeExtensionEffects(name, lifecycle, activeScope);
			const starts: Array<(reason: "live" | "rehearsal") => Work<void> | void> = [],
				stops: Hook[] = [];
			let registering = true;
			const started = (yield* DateTime.nowAsDate).getTime();
			yield* Ref.update(statuses, (items) => [
				...items,
				{ name, status: "loaded", load_ms: 0, error: null } satisfies Status,
			]);
			const api: Api = {
				effects,
				context: (scope) =>
					Effect.gen(function* () {
						const who = yield* identity(scope);
						const request = yield* HttpServerRequest.HttpServerRequest;
						const writable =
							!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
							(request.headers[scopesHeader] ?? "").split(",").includes("write");
						return {
							...who,
							...data(name, who, writable),
							...capabilities(name, who, writable),
							db: sql,
							publicationFence: publication.fence.pipe(Effect.provideService(Lifecycle, lifecycle)),
							params: (yield* HttpRouter.RouteContext).params,
							query: yield* HttpServerRequest.ParsedSearchParams,
						};
					}),
				migrate: (migration, statement, options) =>
					Effect.suspend(() =>
						registering
							? migrate(migration, statement, options)
							: Effect.fail(new KernelError({ code: "input_invalid" })),
					),
				mount: (definition, handlers) => {
					if (!registering) throw new Error("Mount APIs only in the extension factory.");
					mounts.push(
						work(() =>
							mountApi(definition, handlers).pipe(
								Effect.provideContext(services),
								Effect.map((mounted) => {
									pendingDocuments.push(mounted.document);
									for (const route of mounted.routes) {
										validateRoute(route.method, route.path, route.description, route.scope);
										pending.push({ extension: name, ...route });
									}
								}),
							),
						),
					);
				},
				page: (route, handler) =>
					api.route("GET", route, { description: `Human page ${route}`, scope: "read", handler: pageHandler(handler) }),
				cron: (expression, handler) => {
					if (!registering) throw new Error("Register cron jobs only in the extension factory.");
					jobs.push({ expression, schedule: parseCron(expression), handler });
				},
				route: (method, route, options) => {
					if (!registering) throw new Error("Register routes only in the extension factory.");
					validateRoute(method, route, options.description, options.scope);
					pending.push({ extension: name, method, path: route, ...options });
				},
				on: (...args) => {
					if (!registering) throw new Error("Register hooks only in the extension factory.");
					if (args[0] === "start")
						starts.push((reason) =>
							args[1](
								{ reason },
								{
									...data(name),
									...capabilities(name),
									db: sql,
									publicationFence: publication.fence.pipe(Effect.provideService(Lifecycle, lifecycle)),
								},
							),
						);
					else if (args[0] === "shutdown") stops.push(args[1]);
					else {
						const [type, handler] = args;
						if (
							!/^(?:[a-zA-Z0-9_.-]+\*?|\*)$/.test(type) ||
							type.length > 128 ||
							events.length >= 32 ||
							[...new Set([...events.map((hook) => hook.type), type])].join(",").length > 512
						)
							throw new Error(
								"Register at most 32 event hooks, with at most 512 combined type characters and optional trailing wildcards.",
							);
						events.push({ type, handler });
					}
				},
			};
			yield* Effect.gen(function* () {
				const url = (yield* path.toFileUrl(yield* entry.path)).href;
				// Runtime import is the extension boundary; each generation has a fresh process/module cache.
				const imported: unknown = yield* Effect.tryPromise(() => import(url));
				const loaded = yield* Schema.decodeUnknownEffect(factory)(imported);
				yield* work(() => loaded.default(api));
				yield* Effect.all(mounts, { discard: true });
				const overrides: string[] = [];
				for (const [index, route] of pending.entries()) {
					const own = pending
						.slice(0, index)
						.find(
							(other) => other.method === route.method && templatePattern(other.path) === templatePattern(route.path),
						);
					const existing = registrations.findLast(
						(other) => other.method === route.method && templatePattern(other.path) === templatePattern(route.path),
					);
					if (
						own ||
						(existing &&
							(!/^core\.(ts|js)$/.test(existing.extension) || pattern(existing.path) !== pattern(route.path)))
					)
						return yield* Effect.fail(
							new ExtensionError({
								message: `Route ${route.method} ${route.path} conflicts with ${(own ?? existing)?.extension}.`,
							}),
						);
					if (existing) overrides.push(`${route.method} ${route.path} (${existing.extension})`);
				}
				for (const item of pendingDocuments)
					for (const [key, schema] of Object.entries(item.components.schemas)) {
						const previous = [...documents, ...pendingDocuments.filter((other) => other !== item)].find(
							(other) => key in other.components.schemas,
						)?.components.schemas[key];
						if (
							previous &&
							Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(previous) !==
								Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(schema)
						)
							return yield* Effect.fail(
								new ExtensionError({
									message: `OpenAPI schema ${key} conflicts with an earlier extension; give the schema a distinct identifier.`,
								}),
							);
					}
				registrations.push(...pending);
				documents.push(...pendingDocuments);
				yield* diagnostic(name, "ext.loaded", null, { overrides });
			}).pipe(Effect.catchCause((cause) => failed(name, cause, "ext.failed")));
			yield* assertNoPendingMigration(sql);
			registering = false;
			const elapsed = (yield* DateTime.nowAsDate).getTime() - started;
			yield* Ref.update(statuses, (items) =>
				items.map((item) => (item.name === name ? { ...item, load_ms: elapsed } : item)),
			);
			extensions.push({
				name,
				jobs,
				events,
				cursor: yield* Ref.make(events.length ? (yield* boot.fence).published_through : 0),
				start: starts,
				effects,
				shutdown: stops,
				scope: activeScope,
			});
		}
		const stop = (extension: (typeof extensions)[number]) =>
			Effect.gen(function* () {
				const scope = yield* Ref.getAndSet(extension.scope, null);
				if (scope)
					yield* Scope.close(scope, Exit.void).pipe(
						Effect.catchCause((cause) => failed(extension.name, cause, "ext.error")),
					);
			});
		const background =
			(extension: (typeof extensions)[number], scope: Scope.Closeable) =>
			<A, E, R>(task: Effect.Effect<A, E, R>) =>
				task.pipe(
					Effect.provideService(Scope.Scope, scope),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: // Cleanup must run outside the job's scope: closing it here would await this same fiber.
								transitions
									.withPermit(
										Effect.gen(function* () {
											if ((yield* Ref.get(extension.scope)) !== scope) return;
											yield* failed(extension.name, cause, "ext.error");
											yield* stop(extension);
										}).pipe(Effect.uninterruptible),
									)
									.pipe(Effect.forkIn(parentScope), Effect.asVoid),
					),
					Effect.forkIn(scope),
				);
		const changeState = (state: State) =>
			transitions.withPermit(
				Effect.gen(function* () {
					for (const extension of extensions) {
						if (state !== "live") {
							yield* stop(extension);
							continue;
						}
						if (
							(yield* Ref.get(extension.scope)) ||
							(yield* Ref.get(statuses)).find((item) => item.name === extension.name)?.status !== "loaded"
						)
							continue;
						const scope = yield* Scope.fork(parentScope);
						yield* Ref.set(extension.scope, scope);
						yield* Scope.addFinalizer(
							scope,
							Effect.forEach(
								extension.shutdown,
								(hook) =>
									work(hook).pipe(
										Effect.provideService(Scope.Scope, scope),
										Effect.catchCause((cause) => failed(extension.name, cause, "ext.error")),
									),
								{ discard: true },
							).pipe(Effect.orDie),
						);
						yield* Effect.forEach(
							extension.start,
							(hook) => work(() => hook("live")).pipe(Effect.provideService(Scope.Scope, scope)),
							{ discard: true },
						).pipe(
							Effect.catchCause((cause) =>
								failed(extension.name, cause, "ext.error").pipe(Effect.andThen(stop(extension))),
							),
						);
						if ((yield* Ref.get(extension.scope)) !== scope) continue;
						if (extension.events.length) {
							const admit = Ref.get(lifecycle.state).pipe(
								Effect.flatMap((state) => (state === "live" ? Effect.void : Effect.interrupt)),
							);
							yield* runEvents(
								boot.events,
								extension.cursor,
								extension.events.map((hook) => ({
									type: hook.type,
									handle: (event) =>
										work(
											() =>
												hook.handler(event.payload, {
													...data(extension.name),
													...capabilities(extension.name),
													db: sql,
													publicationFence: publication.fence.pipe(Effect.provideService(Lifecycle, lifecycle)),
													event,
												}),
											true,
										).pipe(Effect.provideService(Scope.Scope, scope)),
								})),
								admit,
							).pipe(background(extension, scope));
						}
						for (const job of extension.jobs) {
							yield* runCron(job.schedule, (scheduledAt) =>
								Ref.get(lifecycle.state).pipe(
									Effect.flatMap((state) =>
										state === "live"
											? work(
													() =>
														job.handler({
															...data(extension.name),
															...capabilities(extension.name),
															db: sql,
															publicationFence: publication.fence.pipe(Effect.provideService(Lifecycle, lifecycle)),
															scheduledAt,
														}),
													true,
													diagnostic(extension.name, "cron.ran", null, {
														expression: job.expression,
														scheduled_at: scheduledAt,
													}),
												)
											: Effect.interrupt,
									),
								),
							).pipe(background(extension, scope));
						}
					}
					if (state === "live") yield* onWork;
				}),
			);
		// One health attempt owns rehearsal starts; retries return the same bounded report.
		const rehearse = yield* Effect.cached(
			Effect.gen(function* () {
				if ((yield* Ref.get(lifecycle.state)) !== "rehearsal") return;
				for (const extension of extensions) {
					if ((yield* Ref.get(statuses)).find((item) => item.name === extension.name)?.status !== "loaded") continue;
					yield* Effect.scoped(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Effect.forEach(extension.shutdown, (hook) => work(hook), { discard: true }).pipe(Effect.orDie),
							);
							for (const job of extension.jobs) yield* extension.effects.recordCron(job.expression);
							for (const hook of extension.start) yield* work(() => hook("rehearsal"));
						}),
					).pipe(Effect.catchCause((cause) => failed(extension.name, cause, "ext.error")));
				}
			}),
		);
		const rehearsalReport = Effect.gen(function* () {
			const reports = yield* Effect.forEach(extensions, (extension) => extension.effects.report);
			const records = reports.flatMap((report) => report.records);
			return {
				suppressed: records.slice(0, 64),
				suppressed_overflow: reports.reduce(
					(total, report) => total + report.overflow,
					Math.max(0, records.length - 64),
				),
			};
		});
		const selected = registrations.filter(
			(item, index) =>
				!registrations
					.slice(index + 1)
					.some((later) => later.method === item.method && pattern(later.path) === pattern(item.path)),
		);
		const matcher = FindMyWay.make<Registration>({
			caseSensitive: true,
			ignoreTrailingSlash: false,
			ignoreDuplicateSlashes: false,
		});
		for (const route of selected) matcher.on(route.method, route.path, route);
		return {
			registrations: selected,
			openapi: document(selected, documents),
			diagnostics: Ref.get(diagnostics),
			acknowledgeDiagnostics: (transactions: ReadonlyArray<string>) =>
				Ref.update(diagnostics, (items) => items.filter((item) => !transactions.includes(item.transaction))),
			status: Ref.get(statuses).pipe(
				Effect.map((items) =>
					items.map((item) => ({
						...item,
						events: extensions.find((extension) => extension.name === item.name)?.events.map((hook) => hook.type) ?? [],
						cron: extensions.find((extension) => extension.name === item.name)?.jobs.map((job) => job.expression) ?? [],
						registrations: registrations
							.filter((route) => route.extension === item.name)
							.map(({ method, path, description, scope }) => ({ method, path, description, scope })),
					})),
				),
			),
			changeState,
			rehearse,
			rehearsalReport,
			dispatch: <A, E, R>(fallback: Effect.Effect<A, E, R>) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const pathname = requestPath(request.url);
					if (pathname === null || reserved(pathname)) return yield* fallback;
					const matched =
						matcher.find(request.method, request.url) ??
						(request.method === "HEAD" ? matcher.find("GET", request.url) : undefined);
					if (!matched) return yield* fallback;
					const route = matched.handler;
					const who = yield* identity(route.scope);
					const unavailable = () =>
						HttpServerResponse.text(
							encodeError({
								error: {
									code: "extension_disabled",
									message: `Extension ${route.extension} is disabled.`,
									hint: policy.extension_disabled.hint,
									retriable: false,
								},
							}),
							{
								status: policy.extension_disabled.status,
								contentType: "application/json",
								headers: { "cache-control": "no-store" },
							},
						);
					if ((yield* Ref.get(statuses)).find((item) => item.name === route.extension)?.status !== "loaded")
						return unavailable();
					const web = yield* HttpServerRequest.toWeb(request);
					const headers = new Headers(web.headers);
					for (const name of ["x-boot-secret", "authorization", "cookie"]) headers.delete(name);
					const exposed = HttpServerRequest.fromWeb(new Request(web, { headers }));
					return yield* work(
						() =>
							route.handler(exposed, {
								...who,
								...data(
									route.extension,
									who,
									!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
										(request.headers[scopesHeader] ?? "").split(",").includes("write"),
								),
								...capabilities(
									route.extension,
									who,
									!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
										(request.headers[scopesHeader] ?? "").split(",").includes("write"),
								),
								db: sql,
								publicationFence: publication.fence.pipe(Effect.provideService(Lifecycle, lifecycle)),
								params: matched.params,
								query: matched.searchParams,
							}),
						true,
					).pipe(
						Effect.provideService(HttpServerRequest.HttpServerRequest, exposed),
						Effect.provideService(HttpServerRequest.ParsedSearchParams, matched.searchParams),
						Effect.provideService(HttpRouter.RouteContext, {
							params: matched.params,
							route: HttpRouter.route(route.method, route.path, HttpServerResponse.empty()),
						}),
						Effect.map(HttpServerResponse.fromWeb),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
								const expected = cause.reasons.find(
									(reason) => reason._tag === "Fail" && Schema.is(KernelError)(reason.error),
								);
								if (
									expected?._tag === "Fail" &&
									Schema.is(KernelError)(expected.error) &&
									cause.reasons.every((reason) => reason._tag === "Fail" && Schema.is(KernelError)(reason.error))
								)
									return yield* expected.error;
								yield* transitions.withPermit(
									Effect.gen(function* () {
										yield* failed(route.extension, cause, "ext.error");
										const extension = extensions.find((item) => item.name === route.extension);
										if (extension) yield* stop(extension);
									}).pipe(Effect.uninterruptible),
								);
								return unavailable();
							}),
						),
					);
				}),
		};
	});
export const layer = (directory: string, capabilities: CapabilityFactory, onWork: Effect.Effect<void> = Effect.void) =>
	Layer.effect(Extensions, make(directory, capabilities, onWork)).pipe(Layer.provide(FetchHttpClient.layer));
