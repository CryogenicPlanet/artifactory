import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Path, Ref, Schema, Scope, Semaphore } from "effect";
import { FindMyWay, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { SqlClient } from "effect/unstable/sql";
import { work, type Work } from "./extension-work.ts";
import { parseCron, runCron } from "./extension-cron.ts";
import { identity } from "../conversation-request.ts";
import { Messages } from "./messages.ts";
import { Lifecycle, type State } from "./lifecycle.ts";
import { BootChannel, KernelError } from "./boot-channel.ts";
import { pageHandler } from "./extension-page.ts";
import { extensionData } from "./extension-data.ts";
import { runEvents } from "./extension-events.ts";
import { discoverExtensions } from "./extension-discovery.ts";
import type { Api, CronContext, EventHandler, Hook, RequestContext, RequestServices } from "./extension-api.ts";

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

const reserved = (path: string) => {
	const route = path.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
	return (
		[
			"/_boot",
			"/_kernel",
			"/api/fs",
			"/api/lock",
			"/api/reload",
			"/api/revert",
			"/api/generations",
			"/api/events",
			"/api/stream",
			"/api/tokens",
			"/auth",
			"/approve",
			"/setup",
		].some((prefix) => route === prefix || route.startsWith(prefix + "/")) ||
		["/health", "/api", "/api/ext", "/init", "/init.md", "/.well-known/agent.json"].includes(route)
	);
};
const requestPath = (url: string) => {
	try {
		const path = url.startsWith("/") ? url : new URL(url).pathname;
		return decodeURI(path.split(/[?;#]/, 1)[0] ?? "/");
	} catch {
		return null;
	}
};
const pattern = (route: string) => route.replace(/:[A-Za-z_]\w*/g, ":parameter");
const validateRoute = (method: string, route: string, description: string, scope: string) => {
	if (!route.startsWith("/") || !description.trim()) throw new Error("Extensions require described absolute paths.");
	const segments = route.slice(1).split("/");
	const names = segments.filter((segment) => segment.startsWith(":"));
	if (
		new Set(names).size !== names.length ||
		segments.some((segment, index) =>
			segment.startsWith(":")
				? !/^:[A-Za-z_]\w*$/.test(segment)
				: segment === "*"
					? index !== segments.length - 1
					: /[:*?;#%\\]/.test(segment),
		)
	)
		throw new Error("Use static paths, named :parameters, and an optional terminal /* wildcard.");
	if (!["read", "write", "fs"].includes(scope)) throw new Error("Invalid extension scope.");
	if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method))
		throw new Error("Invalid extension method.");
	if (reserved(route)) throw new Error("Reserved boot or kernel route.");
};

/** Owns one generation's optional extensions; resources exist only in a live scope. */
export class Extensions extends Context.Service<Extensions, Effect.Success<ReturnType<typeof make>>>()(
	"comms/server/Extensions",
) {}
const make = (directory: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const messages = yield* Messages;
		const boot = yield* BootChannel;
		const lifecycle = yield* Lifecycle;
		const data = yield* extensionData;
		const parentScope = yield* Scope.Scope;
		const transitions = yield* Semaphore.make(1);
		const diagnostics = yield* Ref.make<ReadonlyArray<Diagnostic>>([]);
		const statuses = yield* Ref.make<ReadonlyArray<Status>>([]);
		const registrations: Registration[] = [];
		const extensions: Array<{
			readonly name: string;
			readonly start: ReadonlyArray<Hook>;
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
			details: { readonly expression?: string; readonly scheduled_at?: number } = {},
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
			});
		const failed = (name: string, cause: Cause.Cause<unknown>, type: "ext.failed" | "ext.error") =>
			Effect.gen(function* () {
				const error = Cause.pretty(cause).slice(-8192);
				yield* Ref.update(statuses, (items) =>
					items.map((item) => (item.name === name ? { ...item, status: "disabled", error } : item)),
				);
				yield* diagnostic(name, type, error);
			});
		for (const entry of yield* discoverExtensions(directory)) {
			const { name } = entry;
			const jobs: CronJob[] = [];
			const events: Array<{ readonly type: string; readonly handler: EventHandler }> = [];
			const starts: Hook[] = [],
				stops: Hook[] = [];
			let registering = true;
			const started = (yield* DateTime.nowAsDate).getTime();
			yield* Ref.update(statuses, (items) => [
				...items,
				{ name, status: "loaded", load_ms: 0, error: null } satisfies Status,
			]);
			const api: Api = {
				page: (route, handler) =>
					api.route("GET", route, { description: `Human page ${route}`, scope: "read", handler: pageHandler(handler) }),
				cron: (expression, handler) => {
					if (!registering) throw new Error("Register cron jobs only in the extension factory.");
					jobs.push({ expression, schedule: parseCron(expression), handler });
				},
				route: (method, route, options) => {
					if (!registering) throw new Error("Register routes only in the extension factory.");
					validateRoute(method, route, options.description, options.scope);
					registrations.push({ extension: name, method, path: route, ...options });
				},
				on: (...args) => {
					if (!registering) throw new Error("Register hooks only in the extension factory.");
					if (args[0] === "start") starts.push(() => args[1]({ reason: "live" }));
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
				yield* diagnostic(name, "ext.loaded", null);
			}).pipe(Effect.catchCause((cause) => failed(name, cause, "ext.failed")));
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
				shutdown: stops,
				scope: yield* Ref.make<Scope.Closeable | null>(null),
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
							(hook) => work(hook).pipe(Effect.provideService(Scope.Scope, scope)),
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
													db: sql,
													publicationFence: messages.fence,
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
															db: sql,
															publicationFence: messages.fence,
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
				}),
			);
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
						HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: "extension_disabled",
									message: `Extension ${route.extension} is disabled.`,
									hint: "Inspect /api/ext, repair the source, then reload.",
									retriable: false,
								},
							},
							{ status: 503 },
						);
					if ((yield* Ref.get(statuses)).find((item) => item.name === route.extension)?.status !== "loaded")
						return unavailable();
					const publishedThrough = (yield* messages.fence).published_through;
					const web = yield* HttpServerRequest.toWeb(request);
					const headers = new Headers(web.headers);
					for (const name of ["x-boot-secret", "authorization", "cookie"]) headers.delete(name);
					const exposed = HttpServerRequest.fromWeb(new Request(web, { headers }));
					return yield* work(() =>
						route.handler(exposed, {
							...who,
							...data(
								route.extension,
								who,
								!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
									(request.headers["x-comms-scopes"] ?? "").split(",").includes("write"),
							),
							db: sql,
							publishedThrough,
							publicationFence: messages.fence,
							params: matched.params,
							query: matched.searchParams,
						}),
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
								if (expected?._tag === "Fail" && Schema.is(KernelError)(expected.error)) return yield* expected.error;
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
export const layer = (directory: string) => Layer.effect(Extensions, make(directory));
