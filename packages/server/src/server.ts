// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect Crypto has no constant-time comparison.
import { timingSafeEqual } from "node:crypto";
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
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
	Stream,
	type Scope,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { BootChannel, type KernelError, layer as channelLayer } from "./kernel/boot-channel.ts";
import { initialize } from "./kernel/database.ts";
import { migrate } from "./kernel/migrations.ts";
import { type Topics, layer as topicsLayer } from "./kernel/topics.ts";
import { Messages, layer as messagesLayer } from "./kernel/messages.ts";
import { probeHealth } from "./kernel/health.ts";
import { Lifecycle, layer as lifecycleLayer } from "./kernel/lifecycle.ts";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { type Pages, layer as pagesLayer } from "./kernel/pages.ts";
import { routes as boardRoutes } from "./board-http.ts";
import { routes as pageRoutes } from "./pages-http.ts";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import { routes } from "./conversation.ts";
import { Extensions, layer as extensionsLayer } from "./kernel/ext.ts";
import { failure } from "./conversation-request.ts";
import { checkPageWrites, PageWriteCheck, PageWriteUnavailable } from "./kernel/page-write-policy.ts";
import { reconstructPublicPages } from "./kernel/public-page-policy.ts";
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
				yield* initialize;
				yield* migrate(`${import.meta.dirname}/migrations`, boot.epoch);
				return yield* Effect.gen(function* () {
					const messages = yield* Messages;
					const publicPagesContext = yield* Effect.context<SqlClient | BootChannel | Messages | Lifecycle>();
					yield* Ref.set(initializePublicPages, reconstructPublicPages.pipe(Effect.provideContext(publicPagesContext)));
					const extensionContext = yield* Layer.build(extensionsLayer(`${import.meta.dirname}/ext`));
					const extensions = Context.get(extensionContext, Extensions);
					yield* Ref.set(extensionState, extensions.changeState);
					yield* Ref.set(quiesce, messages.quiesce);
					const dispatch = yield* HttpRouter.toHttpEffect(
						Layer.mergeAll(routes(extensions), pageRoutes, boardRoutes(boardDirectory)),
					);
					const context = yield* Effect.context<
						| BootChannel
						| Messages
						| Topics
						| Lifecycle
						| Pages
						| HttpPlatform
						| Crypto.Crypto
						| FileSystem.FileSystem
						| Path.Path
					>();
					const actual = failure(extensions.dispatch(dispatch)).pipe(Effect.provideContext(context));
					const sqlContext = yield* Effect.context<
						Messages | Topics | Lifecycle | BootChannel | SqlClient | Crypto.Crypto
					>();
					const health = healthGate
						.withPermit(
							Effect.gen(function* () {
								const state = yield* Ref.get(lifecycle.state);
								if (!["starting", "candidate", "rehearsal"].includes(state))
									return HttpServerResponse.empty({ status: 409 });
								if (!(yield* Ref.get(lifecycle.healthy))) {
									yield* probeHealth(actual).pipe(Effect.provideContext(sqlContext));
									yield* Ref.set(lifecycle.healthy, true);
								}
								return HttpServerResponse.jsonUnsafe(
									{ status: "ok" },
									{ headers: { "x-comms-writer-epoch": boot.epoch, "x-comms-kernel-protocol": "2" } },
								);
							}),
						)
						.pipe(
							Effect.catchCause(() =>
								Effect.succeed(
									HttpServerResponse.jsonUnsafe(
										{ status: "failed" },
										{ status: 503, headers: { "x-comms-health-ready": "1" } },
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
							if (request.url === "/_kernel/pages/check" && request.method === "POST") {
								if (Object.keys(request.headers).some((name) => name.startsWith("x-comms-")))
									return HttpServerResponse.empty({ status: 403 });
								if (!["accepted", "live", "frozen"].includes(state)) return HttpServerResponse.empty({ status: 503 });
								return yield* Effect.gen(function* () {
									let bytes = 0;
									const chunks: Uint8Array[] = [];
									yield* Stream.runForEach(request.stream, (chunk) =>
										Effect.gen(function* () {
											bytes += chunk.byteLength;
											if (bytes > 1048576) return yield* new PageWriteUnavailable({});
											chunks.push(chunk);
										}),
									);
									const body = Buffer.concat(chunks).toString("utf8");
									const input = yield* Schema.decodeEffect(Schema.fromJsonString(PageWriteCheck), {
										onExcessProperty: "error",
									})(body);
									return HttpServerResponse.jsonUnsafe(yield* checkPageWrites(boot.filename, boot.epoch, input));
								}).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));
							}
							const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
							if (
								!(yield* Ref.get(lifecycle.healthy)) ||
								!["accepted", "live", "frozen"].includes(state) ||
								(mutation && state !== "accepted" && state !== "live")
							)
								return HttpServerResponse.empty({ status: 503 });
							const admitted = yield* Effect.acquireRelease(
								lifecycle.gate.withPermit(
									Effect.gen(function* () {
										const latest = yield* Ref.get(lifecycle.state);
										if (latest === "draining" || (mutation && latest !== "accepted" && latest !== "live")) return false;
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
											})
										: Effect.void,
							);
							return admitted ? yield* actual : HttpServerResponse.empty({ status: 503 });
						}),
					);
					yield* Effect.gen(function* () {
						while (true) {
							yield* lifecycle.gate.withPermit(
								Effect.gen(function* () {
									if ((yield* Ref.get(lifecycle.state)) === "live") {
										yield* messages.relay.pipe(Effect.ignore);
										for (const diagnostic of yield* extensions.diagnostics) {
											yield* messages
												.recordEvent(diagnostic)
												.pipe(
													Effect.andThen(extensions.acknowledgeDiagnostics([diagnostic.transaction])),
													Effect.ignore,
												);
										}
									}
								}),
							);
							yield* Effect.sleep("100 millis");
						}
					}).pipe(Effect.forkScoped);
					yield* backupSchedule.pipe(Effect.forkScoped);
					return yield* Effect.never;
				}).pipe(
					Effect.provide(
						topicsLayer.pipe(Layer.provideMerge(messagesLayer), Layer.provideMerge(pagesLayer(pagesDirectory))),
					),
				);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: boot.filename, disableWAL: true })));
		});
		yield* application.pipe(
			Effect.catchCause((cause) => Effect.logError(cause)),
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
						const transitioned = yield* transitionTo(body.action).pipe(Effect.result);
						if (transitioned._tag === "Failure") return HttpServerResponse.empty({ status: 503 });
						while (
							(yield* Ref.get(lifecycle.mutations)) !== 0 ||
							(body.action === "draining" && (yield* Ref.get(lifecycle.requests)) !== 0)
						)
							yield* Effect.sleep("10 millis");
						const idle = yield* Ref.get(quiesce);
						if (idle) yield* idle;
					}
					return HttpServerResponse.jsonUnsafe({
						state: yield* Ref.get(lifecycle.state),
						mutations: yield* Ref.get(lifecycle.mutations),
						requests: yield* Ref.get(lifecycle.requests),
					});
				}
				const handler = yield* Ref.get(installed);
				return handler ? yield* handler : HttpServerResponse.empty({ status: 503 });
			}),
		);
		yield* Console.log(`COMMS_CHILD_PORT=${http.address.port}`);
		if (lifecycle.initial !== "candidate") yield* Deferred.succeed(go, undefined);
		return yield* Effect.never;
	});
	return yield* program.pipe(
		Effect.provide(
			Layer.mergeAll(
				channelLayer.pipe(Layer.provide(FetchHttpClient.layer)),
				lifecycleLayer,
				BunHttpServer.layer({ hostname: "127.0.0.1", port, idleTimeout: 0, gracefulShutdownTimeout: "1500 millis" }),
			),
		),
	);
}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provideService(Logger.LogToStderr, true));
server.pipe(BunRuntime.runMain);
