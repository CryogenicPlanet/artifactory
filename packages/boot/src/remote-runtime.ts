import { guardianClientLayer } from "@comms/storage/remote-client";
import { RemoteInspector, remoteOwnerInspectorLayer } from "@comms/storage/remote-inspector";
import { asBoot, connectionOf, render, StoreError, type RemoteStore } from "@comms/storage/store";
import { Context, Crypto, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { databaseConfiguration } from "./database-configuration.ts";
import { remoteOwner, type RemoteOwnerIntent } from "./remote-owner.ts";
import { remoteOwnerInventory } from "./remote-owner-inventory.ts";

type Configuration = Extract<Effect.Success<ReturnType<typeof databaseConfiguration>>, { readonly _tag: "remote" }>;

/** Immutable boot owns one account guardian, including its short-lived app SQL pools. */
export const remoteRuntime = (configuration: Configuration, dataDirectory: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const inventory = yield* remoteOwnerInventory(dataDirectory);
		const attempt = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
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
		const inspectorScope = yield* Scope.make();
		const pools = yield* Scope.make();
		// Even an initialization failure retains its unresolved durable intent.
		yield* Effect.addFinalizer(() => Scope.close(inspectorScope, Exit.void));
		const services = yield* Layer.build(
			remoteOwnerInspectorLayer({
				connection,
				attempt,
				scope: "account",
				...(connection.engine === "mysql" ? { mysqlBootConnection: connection } : {}),
			}),
		).pipe(Effect.provideService(Scope.Scope, inspectorScope));
		const inspector = Context.get(services, RemoteInspector);
		yield* owner.bindInspector(inspector.server);
		yield* Effect.addFinalizer(() =>
			owner.close(inspector.assertAccountClosed(Scope.close(pools, Exit.void))).pipe(Effect.orDie),
		);
		const bootServices = yield* Layer.build(
			guardianClientLayer({
				connection,
				attempt,
				register: (session) => inspector.register(session, owner.register(session)),
			}),
		).pipe(Effect.provideService(Scope.Scope, pools));
		const bootSql = Context.get(bootServices, SqlClient.SqlClient);
		const withStore = <A, E, R>(selected: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
			Effect.gen(function* () {
				// Re-derive the credential; callers select an authorized app database, never a new account.
				const bootView = yield* asBoot(selected, configuration.boot);
				const appConnection = yield* connectionOf(bootView, connection.tls);
				const registration = yield* inspector.operationRegistration(owner.register);
				const pool = yield* Scope.fork(pools);
				return yield* Effect.acquireUseRelease(
					Effect.succeed(pool),
					() =>
						Effect.gen(function* () {
							const services = yield* Layer.build(
								guardianClientLayer({
									connection: appConnection,
									attempt,
									register: registration.register,
								}),
							).pipe(Effect.provideService(Scope.Scope, pool));
							return yield* effect.pipe(
								Effect.provideService(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
								Effect.scoped,
							);
						}),
					() => registration.close(Scope.close(pool, Exit.void)).pipe(Effect.orDie),
				);
			});
		const reserveOwner = (store: RemoteStore, childAttempt: string) =>
			Effect.gen(function* () {
				yield* asBoot(store, configuration.boot);
				const child = yield* connectionOf(store, connection.tls);
				if (child.username === connection.username) return yield* new StoreError({ code: "store_descriptor_mismatch" });
				yield* inventory.reserve({
					attempt: childAttempt,
					root: attempt,
					scope: "database",
					engine: child.engine,
					host: child.host,
					port: child.port,
					tls: child.tls,
					database: child.database,
					username: child.username,
				});
				return {
					root: attempt,
					dataDirectory,
					bootStore: Redacted.value(render(configuration.boot)),
					tls: connection.tls,
				};
			});
		return { bootSql, withStore, reserveOwner, rootAttempt: attempt };
	});

export type RemoteRuntime = Effect.Success<ReturnType<typeof remoteRuntime>>;
