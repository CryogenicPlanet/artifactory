// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect Crypto has no constant-time comparison.
import { timingSafeEqual } from "node:crypto";
import type { RemoteChildConfiguration } from "./keeper-configuration.ts";
import { BunHttpServer } from "@effect/platform-bun";
import { RemoteInspector, remoteOwnerInspectorLayer } from "@comms/storage/remote-inspector";
import { asBoot, connectionOf, parseDescriptor, StoreError } from "@comms/storage/store";
import { Cause, Context, Crypto, Effect, Exit, Layer, Schema, Scope } from "effect";
import { RemoteAuthenticationRejected } from "@comms/storage/remote-session";
import {
	HttpIncomingMessage,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { ByteSize } from "effect";
import { remoteOwner } from "./remote-owner.ts";
import { admitRemoteOwner } from "./remote-root-protocol.ts";
import { FetchHttpClient } from "effect/unstable/http";

const Session = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	server: Schema.String,
	database: Schema.String,
	username: Schema.String,
	connectionId: Schema.String,
	tag: Schema.String,
});

/** A keeper-private inspector and registration endpoint outlive editable process failure. */
export const remoteChildGuardian = (
	config: typeof RemoteChildConfiguration.Type,
	appStore: string,
	attempt: string,
	isolated: boolean,
) =>
	Effect.gen(function* () {
		const app = yield* parseDescriptor(appStore);
		const boot = yield* parseDescriptor(config.bootStore);
		if (app._tag === "file" || boot._tag === "file") return yield* new StoreError({ code: "store_engine_mismatch" });
		yield* asBoot(app, boot);
		const connection = yield* connectionOf(app, config.tls);
		const bootConnection = yield* connectionOf(boot, config.tls);
		yield* admitRemoteOwner(config, attempt).pipe(Effect.provide(FetchHttpClient.layer));
		const owner = yield* remoteOwner(
			config.dataDirectory,
			{
				attempt,
				root: config.root,
				scope: "database",
				engine: connection.engine,
				host: connection.host,
				port: connection.port,
				tls: connection.tls,
				database: connection.database,
				username: connection.username,
			},
			isolated ? { uid: 1000, gid: 1000 } : undefined,
		);
		const inspectorScope = yield* Scope.fork(yield* Effect.scope);
		const acquired = yield* Scope.provide(
			Layer.build(
				remoteOwnerInspectorLayer({
					connection,
					attempt,
					...(connection.engine === "mysql" ? { mysqlBootConnection: bootConnection } : {}),
				}),
			),
			inspectorScope,
		).pipe(Effect.exit);
		if (Exit.isFailure(acquired)) {
			yield* Scope.close(inspectorScope, acquired);
			const reason = acquired.cause.reasons.length === 1 ? acquired.cause.reasons[0] : undefined;
			if (reason && Cause.isFailReason(reason) && Schema.is(RemoteAuthenticationRejected)(reason.error))
				yield* owner.authenticationRejected(reason.error);
			return yield* Effect.failCause(acquired.cause);
		}
		const inspector = Context.get(acquired.value, RemoteInspector);
		yield* owner.bindInspector(inspector.server);
		const secret = Buffer.from(yield* (yield* Crypto.Crypto).randomBytes(32)).toString("hex");
		const register = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const supplied = Buffer.from(request.headers["x-comms-guardian-secret"] ?? "");
			const expected = Buffer.from(secret);
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				return HttpServerResponse.empty({ status: 403 });
			const session = yield* request.json.pipe(
				Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
				Effect.flatMap(Schema.decodeUnknownEffect(Session)),
			);
			yield* inspector.register(session, owner.register(session));
			return HttpServerResponse.empty({ status: 204 });
		}).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 409 }))));
		const server = yield* Layer.build(
			HttpRouter.serve(HttpRouter.add("POST", "/register", register), { disableLogger: true }).pipe(
				Layer.provideMerge(
					BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 5, gracefulShutdownTimeout: "1 second" }),
				),
			),
		);
		const address = Context.get(server, HttpServer.HttpServer).address;
		if (address._tag === "UnixPathAddress") return yield* Effect.die("Remote guardian requires loopback TCP");
		return {
			env: {
				REMOTE_GUARDIAN_URL: `http://127.0.0.1:${address.port}`,
				REMOTE_GUARDIAN_SECRET: secret,
				REMOTE_ATTEMPT: attempt,
				DATABASE_TLS: String(config.tls),
			},
			close: (localClosure: Effect.Effect<void, unknown>) => owner.close(inspector.assertAccountClosed(localClosure)),
		};
	});
