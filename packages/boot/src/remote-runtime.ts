import { authorizeTransferDump, type TransferDumpReference } from "./transfer-dump-authority.ts";
import { guardianClientLayer } from "@comms/storage/remote-client";
import { sanitized, failure, type RemoteSession } from "@comms/storage/remote-session";
import { asBoot, connectionOf, render, StoreError, type RemoteStore } from "@comms/storage/store";
import { Config, Context, Effect, Exit, type FileSystem, Layer, type Path, Redacted, Schema, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { databaseConfiguration } from "./database-configuration.ts";
import { RemoteChildConfiguration } from "./keeper-configuration.ts";
import { RemoteRootConfiguration, type RemoteRootRequest } from "./remote-root-protocol.ts";

type Configuration = Extract<Effect.Success<ReturnType<typeof databaseConfiguration>>, { readonly _tag: "remote" }>;

/** Boot borrows guarded SQL leases; the surviving launcher owns all remote closure evidence. */
export const remoteRuntime = (
	configuration: Configuration,
	dataDirectory: string,
	suppliedGuardian?: typeof RemoteRootConfiguration.Type,
) =>
	Effect.gen(function* () {
		const guardian = yield* sanitized(
			suppliedGuardian === undefined
				? Config.Redacted("COMMS_REMOTE_ROOT_CONFIG").pipe(
						Effect.flatMap((value) =>
							Schema.decodeEffect(Schema.fromJsonString(RemoteRootConfiguration))(Redacted.value(value)),
						),
					)
				: Schema.decodeUnknownEffect(RemoteRootConfiguration)(suppliedGuardian),
			"remote_configuration_invalid",
		);
		const client = yield* HttpClient.HttpClient;
		const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
		const request = (body: typeof RemoteRootRequest.Type, status = 204) =>
			sanitized(
				Effect.gen(function* () {
					const response = yield* client.execute(
						HttpClientRequest.post(`${guardian.url}/root`).pipe(
							HttpClientRequest.setHeader("x-chirp-guardian-secret", guardian.secret),
							HttpClientRequest.bodyJsonUnsafe(body),
						),
					);
					if (response.status !== status) return yield* failure("remote_registration_failed");
					return response;
				}).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.timeout("5 seconds")),
				"remote_registration_failed",
			);
		const register = (session: RemoteSession, operation?: string) =>
			request({ action: "register", session, ...(operation === undefined ? {} : { operation }) }).pipe(Effect.asVoid);
		const attempt = guardian.attempt;
		const connection = configuration.bootConnection;
		const pools = yield* Scope.fork(yield* Effect.scope);
		const bootServices = yield* Layer.build(
			guardianClientLayer({ connection, attempt, register: (session) => register(session) }),
		).pipe(Effect.provideService(Scope.Scope, pools));
		const bootSql = Context.get(bootServices, SqlClient.SqlClient);
		const withStore = <A, E, R>(selected: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
			Effect.gen(function* () {
				const bootView = yield* asBoot(selected, configuration.boot);
				const appConnection = yield* connectionOf(bootView, connection.tls);
				return yield* Effect.acquireUseRelease(
					Effect.gen(function* () {
						const { operation } = yield* request({ action: "open-operation" }, 200).pipe(
							Effect.flatMap((response) => response.json),
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ operation: Schema.String }))),
							(effect) => sanitized(effect, "remote_registration_failed"),
						);
						return { operation, pool: yield* Scope.fork(pools) };
					}),
					({ operation, pool }) =>
						Effect.gen(function* () {
							const services = yield* Layer.build(
								guardianClientLayer({
									connection: appConnection,
									attempt,
									register: (session) => register(session, operation),
								}),
							).pipe(Effect.provideService(Scope.Scope, pool));
							return yield* effect.pipe(
								Effect.provideService(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
								Effect.scoped,
							);
						}),
					({ operation, pool }) =>
						Scope.close(pool, Exit.void).pipe(
							Effect.andThen(request({ action: "close-operation", operation })),
							Effect.asVoid,
							Effect.orDie,
						),
				);
			});
		const reserveOwner = (
			store: RemoteStore,
			childAttempt: string,
			scope: "database" | "account" = "database",
			transferDump?: typeof TransferDumpReference.Type,
		) =>
			Effect.gen(function* () {
				if (transferDump) {
					if (scope !== "account") return yield* new StoreError({ code: "store_descriptor_mismatch" });
					yield* authorizeTransferDump(dataDirectory, configuration.boot, store, transferDump, "ready").pipe(
						Effect.provideContext(files),
					);
				} else yield* asBoot(store, configuration.boot);
				const child = yield* connectionOf(store, connection.tls);
				if (
					child.username === connection.username ||
					(transferDump && child.username === configuration.appConnection.username)
				)
					return yield* new StoreError({ code: "store_descriptor_mismatch" });
				const reserved = yield* request(
					{
						action: "reserve-owner",
						store: Redacted.value(yield* render(store)),
						attempt: childAttempt,
						scope,
						...(transferDump ? { transferDump } : {}),
					},
					200,
				).pipe(
					Effect.flatMap((response) => response.json),
					Effect.flatMap(Schema.decodeUnknownEffect(RemoteChildConfiguration)),
					(effect) => sanitized(effect, "remote_configuration_invalid"),
				);
				if (reserved.root !== attempt || reserved.dataDirectory !== dataDirectory)
					return yield* failure("remote_configuration_invalid");
				return reserved;
			});
		const assertAccountClosed = (
			_resourceId: string,
			store: RemoteStore,
			transferDump?: typeof TransferDumpReference.Type,
		) =>
			Effect.gen(function* () {
				if (transferDump) {
					if (_resourceId !== transferDump.resourceId) return yield* failure("remote_configuration_invalid");
					yield* authorizeTransferDump(dataDirectory, configuration.boot, store, transferDump, "cleanup").pipe(
						Effect.provideContext(files),
					);
				} else yield* asBoot(store, configuration.boot);
				const account = yield* connectionOf(store, connection.tls);
				if (
					account.username === connection.username ||
					(transferDump && account.username === configuration.appConnection.username)
				)
					return yield* failure("remote_configuration_invalid");
				yield* request({
					action: "assert-principal-closed",
					store: Redacted.value(yield* render(store)),
					...(transferDump ? { transferDump } : {}),
				});
			});
		return { bootSql, withStore, reserveOwner, assertAccountClosed, rootAttempt: attempt };
	});

export type RemoteRuntime = Effect.Success<ReturnType<typeof remoteRuntime>>;
