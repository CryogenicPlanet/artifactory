import { authorizeTransferDump, type TransferDumpReference } from "./transfer-dump-authority.ts";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect Crypto has no constant-time comparison.
import { timingSafeEqual } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import {
	RemoteInspector,
	remoteOwnerInspectorLayer,
	type RemoteOperationRegistration,
} from "@comms/storage/remote-inspector";
import { asBoot, connectionOf, parseDescriptor, render, StoreError } from "@comms/storage/store";
import { ByteSize, Context, Crypto, Effect, Layer, Redacted, Schedule, Schema, Semaphore } from "effect";
import {
	HttpIncomingMessage,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import type { databaseConfiguration } from "./database-configuration.ts";
import {
	remoteOwner,
	recoverRemoteOwners,
	assertRemoteChildrenClosed,
	assertRemotePrincipalClosed,
	type RemoteOwnerIntent,
} from "./remote-owner.ts";
import { remoteOwnerInventory } from "./remote-owner-inventory.ts";
import { remoteRootAdmission } from "./remote-root-admission.ts";
import { RemoteRootRequest } from "./remote-root-protocol.ts";

type Configuration = Extract<Effect.Success<ReturnType<typeof databaseConfiguration>>, { readonly _tag: "remote" }>;

/** Parent of the SQL-owning boot worker. It never serves product routes or opens writer pools. */
export const remoteRootGuardian = (configuration: Configuration, dataDirectory: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const random = crypto.randomBytes(32).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		const inventory = yield* remoteOwnerInventory(dataDirectory);
		const attempt = yield* random;
		const secret = yield* random;
		const admission = yield* remoteRootAdmission(dataDirectory, attempt);
		const connection = configuration.bootConnection;
		const intent: RemoteOwnerIntent = {
			attempt,
			root: attempt,
			scope: "account",
			engine: connection.engine,
			host: connection.host,
			port: connection.port,
			tls: connection.tls,
			database: connection.database,
			username: connection.username,
		};
		yield* inventory.reserve(intent);
		const owner = yield* remoteOwner(dataDirectory, intent);
		const services = yield* Layer.build(
			remoteOwnerInspectorLayer({
				connection,
				attempt,
				scope: "account",
				...(connection.engine === "mysql" ? { mysqlBootConnection: connection } : {}),
			}),
		);
		const inspector = Context.get(services, RemoteInspector);
		yield* owner.bindInspector(inspector.server);
		const operations = new Map<string, RemoteOperationRegistration>();
		const gate = yield* Semaphore.make(1);
		let closing = false;
		let guardianUrl = "";
		const failure = () => new StoreError({ code: "store_descriptor_mismatch" });
		const selectedConnection = (
			descriptor: string,
			transferDump?: typeof TransferDumpReference.Type,
			phase: "ready" | "cleanup" = "ready",
		) =>
			Effect.gen(function* () {
				const store = yield* parseDescriptor(descriptor);
				if (store._tag === "file") return yield* failure();
				if (transferDump) yield* authorizeTransferDump(dataDirectory, configuration.boot, store, transferDump, phase);
				else yield* asBoot(store, configuration.boot);
				const selected = yield* connectionOf(store, connection.tls);
				if (
					selected.username === connection.username ||
					(transferDump && selected.username === configuration.appConnection.username)
				)
					return yield* failure();
				return selected;
			});
		const dispatch = (input: typeof RemoteRootRequest.Type) =>
			gate.withPermit(
				Effect.gen(function* () {
					if (closing) return yield* failure();
					switch (input.action) {
						case "register": {
							if (input.operation !== undefined) {
								const operation = operations.get(input.operation);
								if (!operation) return yield* failure();
								yield* operation.register(input.session);
							} else yield* inspector.register(input.session, owner.register(input.session));
							return HttpServerResponse.empty({ status: 204 });
						}
						case "open-operation": {
							const id = yield* random;
							operations.set(id, yield* inspector.operationRegistration(owner.register));
							return HttpServerResponse.jsonUnsafe({ operation: id });
						}
						case "close-operation": {
							const operation = operations.get(input.operation);
							if (!operation) return yield* failure();
							// The immutable worker sends this only after its scoped leases and pool close.
							yield* operation.close(Effect.void);
							operations.delete(input.operation);
							return HttpServerResponse.empty({ status: 204 });
						}
						case "reserve-owner": {
							if (input.transferDump && input.scope !== "account") return yield* failure();
							const selected = yield* selectedConnection(input.store, input.transferDump);
							const child: RemoteOwnerIntent = {
								attempt: input.attempt,
								root: attempt,
								scope: input.scope,
								engine: selected.engine,
								host: selected.host,
								port: selected.port,
								tls: selected.tls,
								database: selected.database,
								username: selected.username,
							};
							// Journal reservation precedes the independent expected-owner publication.
							// No acknowledgement is possible until both have reached durable storage.
							yield* admission.reserve(child);
							yield* inventory.reserve(child);
							return HttpServerResponse.jsonUnsafe({
								root: attempt,
								dataDirectory,
								bootStore: Redacted.value(yield* render(configuration.boot)),
								tls: connection.tls,
								guardian: { url: guardianUrl, secret, attempt },
								...(input.transferDump ? { transferDump: input.transferDump } : {}),
							});
						}
						case "admit-owner":
							yield* admission.admit(input.attempt);
							return HttpServerResponse.empty({ status: 204 });
						case "assert-principal-closed": {
							const selected = yield* selectedConnection(input.store, input.transferDump, "cleanup");
							const expected = yield* inventory.snapshot;
							yield* assertRemotePrincipalClosed(dataDirectory, expected, attempt, selected);
							return HttpServerResponse.empty({ status: 204 });
						}
					}
				}).pipe(Effect.uninterruptible),
			);
		const request = Effect.gen(function* () {
			const req = yield* HttpServerRequest.HttpServerRequest;
			const supplied = Buffer.from(req.headers["x-chirp-guardian-secret"] ?? "");
			const expected = Buffer.from(secret);
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				return HttpServerResponse.empty({ status: 403 });
			const input = yield* req.json.pipe(
				Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)),
				Effect.flatMap(Schema.decodeUnknownEffect(RemoteRootRequest)),
			);
			return yield* dispatch(input);
		}).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 409 }))));
		const server = yield* Layer.build(
			HttpRouter.serve(HttpRouter.add("POST", "/root", request), { disableLogger: true }).pipe(
				Layer.provideMerge(
					BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 5, gracefulShutdownTimeout: "1 second" }),
				),
			),
		);
		const address = Context.get(server, HttpServer.HttpServer).address;
		if (address._tag === "UnixPathAddress") return yield* failure();
		guardianUrl = `http://127.0.0.1:${address.port}`;
		return {
			configuration: { url: guardianUrl, secret, attempt },
			close: <E, R>(workerClosure: Effect.Effect<void, E, R>) =>
				Effect.gen(function* () {
					yield* gate.withPermit(
						Effect.gen(function* () {
							closing = true;
							yield* admission.close;
						}),
					);
					const children = yield* admission.workerClosed(workerClosure);
					for (const child of children)
						if (!child.admitted) {
							const neverOpened = yield* remoteOwner(dataDirectory, child.intent);
							yield* neverOpened.neverOpened;
						}
					const expected = yield* inventory.snapshot;
					// Separate keepers retain their inspectors and finish their own positive closure receipts.
					yield* assertRemoteChildrenClosed(dataDirectory, expected, attempt).pipe(
						Effect.retry({ times: 149, schedule: Schedule.spaced("200 millis") }),
					);
					yield* owner
						.close(inspector.assertAccountClosed(Effect.void))
						.pipe(Effect.retry({ times: 149, schedule: Schedule.spaced("200 millis") }));
					yield* recoverRemoteOwners(dataDirectory, expected);
				}),
		};
	});
