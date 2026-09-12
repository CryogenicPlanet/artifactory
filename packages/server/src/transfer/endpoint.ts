import { remoteRuntime, type databaseConfiguration, type RemoteTransferConfiguration } from "@comms/boot";
import { clientLayer } from "@comms/storage/client";
import type { Store } from "@comms/storage/store";
import { TransferRejected } from "@comms/storage/store-transfer-schema";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

type Configuration = Effect.Success<ReturnType<typeof databaseConfiguration>>;
type Owner = Exclude<typeof RemoteTransferConfiguration.Type.source, null>;

/** A worker-scoped immutable endpoint. withApp uses boot credentials only for immutable
 * inspection/copy; editable migrations always run through the separate app keeper.
 * SQLite read-only mode is a driver restriction; remote read-only phases are enforced by
 * the selected operations, not privileges. Callbacks return materialized results only. */
export const transferEndpoint = (configuration: Configuration, owner: Owner | null, sqliteReadonly = false) =>
	Effect.gen(function* () {
		if (configuration._tag === "remote") {
			if (!owner) return yield* new TransferRejected({ code: "transfer_binding_invalid" });
			const runtime = yield* remoteRuntime(configuration, owner.directory, owner.guardian);
			return {
				boot: runtime.bootSql,
				runtime,
				withApp: <A, E, R>(store: Store, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
					store._tag === "file"
						? Effect.fail(new TransferRejected({ code: "transfer_binding_invalid" }))
						: runtime.withStore(store, effect),
			};
		}
		if (owner) return yield* new TransferRejected({ code: "transfer_binding_invalid" });
		const context = yield* Layer.build(clientLayer(configuration.boot, { readonly: sqliteReadonly }));
		return {
			boot: Context.get(context, SqlClient.SqlClient),
			runtime: undefined,
			withApp: <A, E, R>(store: Store, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
				store._tag !== "file"
					? Effect.fail(new TransferRejected({ code: "transfer_binding_invalid" }))
					: Effect.scoped(
							Effect.gen(function* () {
								const services = yield* Layer.build(clientLayer(store, { readonly: sqliteReadonly }));
								return yield* effect.pipe(
									Effect.provideService(SqlClient.SqlClient, Context.get(services, SqlClient.SqlClient)),
								);
							}),
						),
		};
	});
