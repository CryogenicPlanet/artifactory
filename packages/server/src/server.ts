import { MigrationWarnings, layer as migrationWarningsLayer } from "./kernel/migration-portability.ts";
import { logEvents } from "./kernel/log-events.ts";
import { requestSpan } from "./kernel/request-span.ts";
import { Publication, layer as publicationLayer } from "./kernel/publication.ts";
import { extensionCapabilities } from "./ext/core/capabilities.ts";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect Crypto has no constant-time comparison.
import { timingSafeEqual } from "node:crypto";
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { databaseLayer } from "./kernel/remote-database.ts";
import { initializeRemoteKernelSchema } from "./kernel/schema.ts";
import {
	Config,
	Context,
	type Crypto,
	type FileSystem,
	type Path,
	Console,
	Deferred,
	Effect,
	Layer,
	Logger,
	Redacted,
	Ref,
	Schema,
	Semaphore,
	type Scope,
} from "effect";
import {
	FetchHttpClient,
	type HttpClient,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { BootChannel, KernelError, layer as channelLayer } from "./kernel/boot-channel.ts";
import { initialize } from "./ext/core/schema.ts";
import { migrate } from "./kernel/migrations.ts";
import { type Topics, layer as topicsLayer } from "./ext/core/topics.ts";
import { type Messages, layer as messagesLayer } from "./ext/core/messages.ts";
import { probeHealth, readinessRoute } from "./kernel/health.ts";
import { healthFailure } from "./kernel/health-failure.ts";
import { Lifecycle, RequestMutation, layer as lifecycleLayer } from "./kernel/lifecycle.ts";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { type Pages, layer as pagesLayer } from "./ext/core/pages.ts";
import { routes as boardRoutes } from "./board-http.ts";
import { routes as pageRoutes } from "./pages-http.ts";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import { routes } from "./conversation.ts";
import { Extensions, layer as extensionsLayer } from "./kernel/ext.ts";
import { failure } from "./conversation-request.ts";
import { reconstructPublicPages } from "./ext/core/public-page-policy.ts";
import { backupSchedule } from "./backup-schedule.ts";

type Handler = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	HttpServerError.HttpServerError,
	HttpServerRequest.HttpServerRequest | Scope.Scope
>;
const server = Effect.gen(function* () {
	const port = yield* Config.schema(
		Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
		"PORT",
	);
	const secret = yield* Config.Redacted("BOOT_SECRET");
	const expected = Buffer.from(Redacted.value(secret));
	const program = Effect.gen(function* () {
		const boot = yield* BootChannel;
		const pagesDirectory = yield* Config.String("PAGES_DIRECTORY");
		const boardDirectory = yield* Config.String("BOARD_DIRECTORY").pipe(
			Config.withDefault(`${import.meta.dirname}/board`),
		);
		const lifecycle = yield* Lifecycle;
		const migrationWarnings = yield* MigrationWarnings;
		const http = yield* HttpServer.HttpServer;
		if (http.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
		const host = `127.0.0.1:${http.address.port}`;
		const go = yield* Deferred.make<void>();
		const installed = yield* Ref.make<Handler | null>(null);
		const extensionState = yield* Ref.make<Extensions["Service"]["changeState"] | null>(null);
		const quiesce = yield* Ref.make<Effect.Effect<void> | null>(null);
		const initializePublicPages = yield* Ref.make<Effect.Effect<void, KernelError> | null>(null);
		const healthGate = yield* Semaphore.make(1);
		const controlGate = yield* Semaphore.make(1);
		const transitionTo = (state: Parameters<Extensions["Service"]["changeState"]>[0]) =>
			controlGate.withPermit(
				Effect.gen(function* () {
					if (state === "accepted" || state === "live") {
						const initialize = yield* Ref.get(initializePublicPages);
						if (initialize) {
							yield* initialize;
							yield* Ref.set(initializePublicPages, null);
						}
					}
					yield* lifecycle.gate.withPermit(Ref.set(lifecycle.state, state));
					if (state === "draining") yield* Deferred.succeed(lifecycle.drained, undefined);
					const transition = yield* Ref.get(extensionState);
					if (transition) yield* transition(state);
				}).pipe(Effect.uninterruptible),
			);
		const application = Effect.gen(function* () {
			yield* Deferred.await(go);
			return yield* Effect.gen(function* () {
				yield* initializeRemoteKernelSchema(yield* SqlClient, boot.epoch);
				yield* initialize;
				yield* migrate(`${import.meta.dirname}/migrations`, boot.epoch);
				return yield* Effect.gen(function* () {
					const publication = yield* Publication;
					const loggers = yield* Logger.CurrentLoggers;
					const publicPagesContext = yield* Effect.context<
						SqlClient | BootChannel | Publication | Messages | Lifecycle
					>();
					yield* Ref.set(initializePublicPages, reconstructPublicPages.pipe(Effect.provideContext(publicPagesContext)));
					const extensionContext = yield* Layer.build(
						extensionsLayer(`${import.meta.dirname}/ext`, yield* extensionCapabilities, publication.wake),
					);
					const extensions = Context.get(extensionContext, Extensions);
					yield* Ref.set(extensionState, extensions.changeState);
					yield* Ref.set(quiesce, publication.quiesce);
					const dispatch = yield* HttpRouter.toHttpEffect(
						Layer.mergeAll(routes(extensions), pageRoutes, boardRoutes(boardDirectory), readinessRoute),
					);
					const context = yield* Effect.context<
						| BootChannel
						| Publication
						| Messages
						| Topics
						| Lifecycle
						| Pages
						| HttpClient.HttpClient
						| HttpPlatform
						| Crypto.Crypto
						| FileSystem.FileSystem
						| Path.Path
					>();
					const actual = failure(extensions.dispatch(dispatch)).pipe(
						Effect.provideContext(Context.add(context, Logger.CurrentLoggers, loggers)),
					);
					const sqlContext = yield* Effect.context<Publication | Lifecycle | BootChannel | SqlClient | Crypto.Crypto>();
					const health = healthGate
						.withPermit(
							Effect.gen(function* () {
								const state = yield* Ref.get(lifecycle.state);
								if (!["starting", "candidate", "rehearsal"].includes(state))
									return HttpServerResponse.empty({ status: 409 });
								if (!(yield* Ref.get(lifecycle.healthy))) {
									yield* probeHealth(
										Effect.gen(function* () {
											yield* extensions.rehearse;
											const response = yield* actual.pipe(
												Effect.provideService(
													HttpServerRequest.HttpServerRequest,
													HttpServerRequest.fromWeb(new Request("http://kernel/_kernel/readiness")),
												),
											);
											if (response.status !== 200 || response.headers["x-comms-readiness"] !== "kernel")
												return yield* new KernelError({ code: "health_failed" });
										}),
										state === "rehearsal",
									).pipe(Effect.provideContext(sqlContext));
									yield* Ref.set(lifecycle.healthy, true);
								}
								return HttpServerResponse.jsonUnsafe(
									{
										status: "ok",
										...(yield* extensions.rehearsalReport),
										...(yield* migrationWarnings.report),
									},
									{
										headers: {
											"x-comms-writer-epoch": boot.epoch,
											"x-comms-kernel-protocol": "2",
											"x-comms-rehearsal-report": "1",
										},
									},
								);
							}),
						)
						.pipe(
							Effect.catchCause((cause) =>
								Console.error(healthFailure("probe", cause)).pipe(
									Effect.as(
										HttpServerResponse.jsonUnsafe(
											{ status: "failed" },
											{ status: 503, headers: { "x-comms-health-ready": "1" } },
										),
									),
								),
							),
						);
					yield* Ref.set(
						installed,
						Effect.gen(function* () {
							const request = yield* HttpServerRequest.HttpServerRequest;
							if (request.url === "/health" && request.method === "GET") return yield* health;
							const state = yield* Ref.get(lifecycle.state);

							const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
							// Boot strips caller metadata and forwards this identifier only after admission.
							// A frozen control can overtake that already-admitted request on the loopback connection.
							const forwarded = /^[a-f0-9]{32}$/.test(request.headers["x-comms-request-id"] ?? "");
							if (
								!(yield* Ref.get(lifecycle.healthy)) ||
								!["accepted", "live", "frozen"].includes(state) ||
								(mutation && state !== "accepted" && state !== "live" && !(state === "frozen" && forwarded))
							)
								return HttpServerResponse.empty({ status: 503 });
							const admitted = yield* Effect.acquireRelease(
								lifecycle.gate.withPermit(
									Effect.gen(function* () {
										const latest = yield* Ref.get(lifecycle.state);
										if (
											latest === "draining" ||
											(mutation && latest !== "accepted" && latest !== "live" && !(latest === "frozen" && forwarded))
										)
											return false;
										yield* Ref.update(lifecycle.requests, (count) => count + 1);
										if (mutation) yield* Ref.update(lifecycle.mutations, (count) => count + 1);
										return true;
									}),
								),
								(admitted) =>
									admitted
										? Effect.gen(function* () {
												yield* Ref.update(lifecycle.requests, (count) => count - 1);
												if (mutation) yield* Ref.update(lifecycle.mutations, (count) => count - 1);
												yield* lifecycle.activityChanged;
											})
										: Effect.void,
							);
							if (!admitted) return HttpServerResponse.empty({ status: 503 });
							if (!mutation) return yield* actual;
							const active = yield* Ref.make(true);
							return yield* actual.pipe(
								Effect.provideService(RequestMutation, active),
								Effect.ensuring(Ref.set(active, false)),
							);
						}),
					);
					yield* publication
						.runRelay(
							lifecycle.gate.withPermit(
								Effect.gen(function* () {
									if ((yield* Ref.get(lifecycle.state)) !== "live") return;
									yield* publication.relay;
									for (const diagnostic of yield* extensions.diagnostics) {
										yield* publication.recordEvent(diagnostic);
										yield* extensions.acknowledgeDiagnostics([diagnostic.transaction]);
									}
								}),
							),
						)
						.pipe(Effect.forkScoped);
					yield* backupSchedule.pipe(Effect.forkScoped);
					return yield* Effect.never;
				}).pipe(
					Effect.provide(Logger.layer([logEvents])),
					Effect.provide(
						topicsLayer.pipe(
							Layer.provideMerge(messagesLayer.pipe(Layer.provideMerge(publicationLayer))),
							Layer.provideMerge(pagesLayer(pagesDirectory)),
						),
					),
				);
			}).pipe(Effect.provide(databaseLayer(boot.store)));
		});
		yield* application.pipe(
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					// A completed initialization failure cannot become ready on a later poll.
					yield* Ref.set(
						installed,
						Effect.gen(function* () {
							const request = yield* HttpServerRequest.HttpServerRequest;
							return request.url === "/health" && request.method === "GET"
								? HttpServerResponse.jsonUnsafe(
										{ status: "failed" },
										{ status: 503, headers: { "x-comms-health-ready": "1" } },
									)
								: HttpServerResponse.empty({ status: 503 });
						}),
					);
					yield* Console.error(healthFailure("initialize", cause));
				}),
			),
			Effect.forkScoped,
		);
		yield* HttpServer.serveEffect(
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const supplied = Buffer.from(request.headers["x-boot-secret"] ?? "");
				if (
					supplied.length !== expected.length ||
					!timingSafeEqual(supplied, expected) ||
					request.headers.host !== host ||
					Object.keys(request.headers).some((name) => name.startsWith("x-forwarded-") || name === "forwarded")
				)
					return HttpServerResponse.empty({ status: 403 });
				if (request.url === "/_kernel/ping" && request.method === "GET") {
					if (Object.keys(request.headers).some((name) => name.startsWith("x-comms-")))
						return HttpServerResponse.empty({ status: 403 });
					return HttpServerResponse.empty({
						status: (yield* Ref.get(lifecycle.healthy)) ? 200 : 503,
						headers: {
							"x-comms-writer-epoch": boot.epoch,
							"x-comms-kernel-protocol": "2",
						},
					});
				}
				if (request.url === "/_kernel/control" && request.method === "POST") {
					// Genuine boot control has the attempt secret only, never proxied caller metadata.
					if (Object.keys(request.headers).some((name) => name.startsWith("x-comms-")))
						return HttpServerResponse.empty({ status: 403 });
					const body = yield* request.json.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.Struct({ action: Schema.Literals(["go", "accepted", "live", "frozen", "draining"]) }),
							),
						),
					);
					if (body.action === "go") yield* Deferred.succeed(go, undefined);
					else if (body.action === "accepted" || body.action === "live") {
						if (!(yield* Ref.get(lifecycle.healthy))) return HttpServerResponse.empty({ status: 409 });
						const transitioned = yield* transitionTo(body.action).pipe(Effect.result);
						if (transitioned._tag === "Failure") return HttpServerResponse.empty({ status: 503 });
					} else {
						const action = body.action;
						const completed = yield* Effect.gen(function* () {
							yield* transitionTo(action);
							yield* lifecycle.awaitIdle(action === "draining");
							const idle = yield* Ref.get(quiesce);
							if (idle) yield* idle;
						}).pipe(Effect.timeout("4 seconds"), Effect.result);
						// Timeout is not closure proof. Boot retains its keeper/watchdog fallback.
						if (completed._tag === "Failure") return HttpServerResponse.empty({ status: 503 });
					}
					return HttpServerResponse.jsonUnsafe({
						state: yield* Ref.get(lifecycle.state),
						mutations: yield* Ref.get(lifecycle.mutations),
						requests: yield* Ref.get(lifecycle.requests),
					});
				}
				const handler = yield* Ref.get(installed);
				return handler ? yield* requestSpan(handler) : HttpServerResponse.empty({ status: 503 });
			}),
		);
		yield* Console.log(`COMMS_CHILD_PORT=${http.address.port}`);
		if (lifecycle.initial !== "candidate") yield* Deferred.succeed(go, undefined);
		return yield* Effect.never;
	});
	return yield* program.pipe(
		Effect.provide(
			Layer.mergeAll(
				channelLayer,
				lifecycleLayer,
				migrationWarningsLayer.pipe(Layer.provide(lifecycleLayer)),
				BunHttpServer.layer({ hostname: "127.0.0.1", port, idleTimeout: 0, gracefulShutdownTimeout: "1500 millis" }),
			),
		),
	);
}).pipe(
	Effect.scoped,
	Effect.provide(FetchHttpClient.layer),
	Effect.provide(BunServices.layer),
	Effect.provideService(Logger.LogToStderr, true),
);
server.pipe(BunRuntime.runMain);
