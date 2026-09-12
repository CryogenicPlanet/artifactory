import { on } from "@comms/storage/dialect";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { remoteAppKernelOperations } from "./app-kernel-schema.ts";
import { decodeRows } from "./decode-rows.ts";
import { EventError } from "./events.ts";

export interface KernelProgress {
	readonly next: number;
	readonly active: string | null;
}
const invalid = () => new EventError({ code: "app_store_identity_invalid" });

/** Shared native kernel initialization only. Callers own the durable reservation and every checkpoint. */
export const replayAppKernel = <E>(options: {
	readonly app: SqlClient.SqlClient;
	readonly principal: string;
	readonly bootPrincipal: string;
	readonly databaseName: string;
	readonly bootDatabase: string;
	readonly progress: KernelProgress | undefined;
	readonly initialize: Effect.Effect<KernelProgress, E>;
	readonly checkpoint: (index: number, prior: string | null, active: string | null) => Effect.Effect<KernelProgress, E>;
	readonly validate: Effect.Effect<void, E>;
}) =>
	Effect.gen(function* () {
		const { app, principal, bootPrincipal, databaseName, bootDatabase, checkpoint } = options;
		let progress = options.progress;
		const operations = remoteAppKernelOperations(app, principal);
		const names = operations.map((operation) => operation.name);
		yield* options.validate;
		const database = yield* on(app, {
			sqlite: () => {
				throw new Error("Expected a remote app client");
			},
			pg: () => app`SELECT current_database() AS name`,
			mysql: () => app`SELECT DATABASE() AS name`,
		}).pipe(decodeRows(Schema.Struct({ name: Schema.String })));
		if (database.length !== 1 || database[0]?.name !== databaseName || databaseName === bootDatabase)
			return yield* invalid();
		yield* on(app, {
			sqlite: () => {
				throw new Error("Expected a remote app client");
			},
			pg: () =>
				Effect.gen(function* () {
					const rows =
						yield* app`SELECT current_user AS name,session_user AS session,NOT pg_has_role(${principal}::name,d.datdba,'MEMBER') AS database_ok,NOT pg_has_role(${principal}::name,n.nspowner,'MEMBER') AS schema_ok,NOT pg_has_role(${principal}::name,${bootPrincipal}::name,'MEMBER') AS role_ok FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n WHERE d.datname=current_database() AND n.nspname='public'`.pipe(
							decodeRows(
								Schema.Struct({
									name: Schema.String,
									session: Schema.String,
									database_ok: Schema.Boolean,
									schema_ok: Schema.Boolean,
									role_ok: Schema.Boolean,
								}),
							),
						);
					if (
						rows.length !== 1 ||
						rows[0]?.name !== bootPrincipal ||
						rows[0]?.session !== bootPrincipal ||
						!rows[0]?.database_ok ||
						!rows[0]?.schema_ok ||
						!rows[0]?.role_ok
					)
						return yield* invalid();
				}).pipe(Effect.asVoid),
			mysql: () => Effect.void,
		});
		const catalog = yield* on(app, {
			sqlite: () => {
				throw new Error("Expected a remote app client");
			},
			pg: () =>
				app`SELECT c.relname AS name,n.nspname AS namespace,CASE WHEN pg_get_userbyid(c.relowner)=current_user THEN 1 ELSE 0 END AS owned FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT starts_with(n.nspname::text,'pg_toast') AND NOT starts_with(n.nspname::text,'pg_temp_') AND c.relkind IN ('r','p','v','m','f')`,
			mysql: () =>
				app`SELECT TABLE_NAME AS name,'public' AS namespace,1 AS owned FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()`,
		}).pipe(decodeRows(Schema.Struct({ name: Schema.String, namespace: Schema.String, owned: Schema.Int })));
		const owned = progress
			? names
					.slice(0, progress.next + (progress.active === null ? 0 : 1))
					.filter((name) => name.startsWith("table:"))
					.map((name) => name.slice(6))
			: [];
		if (catalog.some((table) => table.namespace !== "public" || table.owned !== 1 || !owned.includes(table.name)))
			return yield* invalid();
		if (!progress) progress = yield* options.initialize;
		for (let index = 0; index < progress.next; index++) {
			yield* options.validate;
			const operation = operations[index];
			if (!operation || !(yield* operation.postcondition)) return yield* invalid();
		}
		for (let index = progress.next; index < operations.length; index++) {
			yield* options.validate;
			const operation = operations[index];
			if (!operation) return yield* invalid();
			const complete = yield* operation.postcondition;
			if (progress.active === null) {
				if (complete && !operation.name.startsWith("grant:")) return yield* invalid();
				progress = yield* checkpoint(index, null, operation.name);
			}
			const apply = Effect.gen(function* () {
				if (!complete) yield* operation.run;
				if (!(yield* operation.postcondition)) return yield* invalid();
			});
			yield* on(app, {
				sqlite: () => {
					throw new Error("Expected a remote app client");
				},
				pg: () => app.withTransaction(apply),
				mysql: () => apply,
			});
			progress = yield* checkpoint(index, operation.name, null);
		}
	});
