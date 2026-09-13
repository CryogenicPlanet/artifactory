import { advisoryClientLayer, directClientLayer } from "@comms/storage/remote-client";
import { asBoot, connectionOf, type RemoteStore } from "@comms/storage/store";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { databaseConfiguration } from "./database-configuration.ts";

type Configuration = Extract<Effect.Success<ReturnType<typeof databaseConfiguration>>, { readonly _tag: "remote" }>;

export const remoteRuntime = (configuration: Configuration, _dataDirectory: string) =>
	Effect.gen(function* () {
		const services = yield* Layer.build(advisoryClientLayer({ connection: configuration.bootConnection }));
		const bootSql = Context.get(services, SqlClient.SqlClient);
		const access = <A, E, R>(
			selected: RemoteStore,
			effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
			writing: boolean,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const bootView = yield* asBoot(selected, configuration.boot);
					const connection = yield* connectionOf(bootView, configuration.bootConnection.tls);
					return yield* effect.pipe(
						Effect.provide(writing ? advisoryClientLayer({ connection }) : directClientLayer({ connection })),
					);
				}),
			);
		return {
			bootSql,
			tls: configuration.bootConnection.tls,
			withStore: <A, E, R>(selected: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
				access(selected, effect, false),
			withWriter: <A, E, R>(selected: RemoteStore, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
				access(selected, effect, true),
		};
	});
export type RemoteRuntime = Effect.Success<ReturnType<typeof remoteRuntime>>;
